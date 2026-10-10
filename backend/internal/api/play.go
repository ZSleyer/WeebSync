package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// The player streams a video straight from where it lives - a local media
// root or a remote server - so a file can be looked into without downloading
// it first.
//
// Two ways to play:
//   - direct: the raw bytes with Range support, for what the browser decodes
//     itself (H.264, VP9, AV1 in MKV/MP4/WebM with AAC/Opus/...)
//   - HLS (play_hls.go): ffmpeg transcodes to H.264/AAC, for HEVC, Bluray
//     audio, a second audio track or a picture subtitle burned into the image
//
// Text subtitles (ASS, SRT, WebVTT) are never burned in: ffmpeg hands them over
// as ASS together with the fonts the file carries, and the browser renders them
// with libass (JASSUB) in both modes.

// playSource names the file to play: a local path (server 0) or a path on a
// remote server.
type playSource struct {
	userID   int64
	serverID int64
	path     string
	// low leases the remote connection at the crawler's priority: background
	// reads (the subtitle pass) must not starve the picture of connections
	low bool
}

func playSourceFrom(r *http.Request) (playSource, error) {
	q := r.URL.Query()
	src := playSource{userID: auth.UserFrom(r.Context()).ID, path: q.Get("path")}
	if v := q.Get("server"); v != "" && v != "0" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return src, errors.New("invalid server")
		}
		src.serverID = id
	}
	ext := strings.ToLower(filepath.Ext(src.path))
	if !transfer.VideoExt[ext] && !transfer.SubExt[ext] {
		return src, errors.New("not a video or subtitle file")
	}
	return src, nil
}

// playFile is an open source file: seekable, sized, and closed when done.
type playFile struct {
	io.ReadSeeker
	size    int64
	modTime time.Time
	close   func()
}

// open opens the source for reading. A local file stays inside its os.Root; a
// remote one is read through a leased connection, reopened at the new offset
// on every seek.
func (s *Server) openPlay(ctx context.Context, src playSource) (*playFile, error) {
	if src.serverID == 0 {
		local, err := s.openLocal(src.path)
		if err != nil {
			return nil, err
		}
		f, err := local.Root.Open(local.Name)
		if err != nil {
			local.Close()
			return nil, err
		}
		fi, err := f.Stat()
		if err != nil || fi.IsDir() {
			f.Close()
			local.Close()
			return nil, errors.New("not a file")
		}
		return &playFile{ReadSeeker: f, size: fi.Size(), modTime: fi.ModTime(), close: func() { f.Close(); local.Close() }}, nil
	}
	prio := pool.PriHigh
	if src.low {
		prio = pool.PriLow
	}
	client, _, err := s.dialServer(ctx, src.userID, src.serverID, prio)
	if err != nil {
		return nil, err
	}
	size, err := client.Size(src.path)
	if err != nil {
		client.Close()
		return nil, err
	}
	rf := &remoteFile{c: client, path: src.path, size: size}
	return &playFile{ReadSeeker: rf, size: size, close: rf.Close}, nil
}

// remoteFile is an io.ReadSeeker over remote.Client.Open(path, offset). A seek
// only records the offset; the next Read opens the file there.
type remoteFile struct {
	c         remote.Client
	path      string
	size, off int64
	rc        io.ReadCloser
}

func (f *remoteFile) Read(p []byte) (int, error) {
	if f.off >= f.size {
		return 0, io.EOF
	}
	if f.rc == nil {
		rc, err := f.c.Open(f.path, f.off)
		if err != nil {
			return 0, err
		}
		f.rc = rc
	}
	n, err := f.rc.Read(p)
	f.off += int64(n)
	return n, err
}

func (f *remoteFile) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekCurrent:
		offset += f.off
	case io.SeekEnd:
		offset += f.size
	}
	if offset < 0 {
		return 0, errors.New("negative offset")
	}
	if offset != f.off && f.rc != nil {
		f.rc.Close()
		f.rc = nil
	}
	f.off = offset
	return offset, nil
}

func (f *remoteFile) Close() {
	if f.rc != nil {
		f.rc.Close()
	}
	f.c.Close()
}

// playMime is the Content-Type a browser needs to try the bytes at all. The
// container's own type, not a sniffed one: the server sends nosniff, and the
// alpine image has no mime table that knows .mkv.
func playMime(name string) string {
	switch ext := strings.ToLower(filepath.Ext(name)); ext {
	case ".mkv":
		return "video/x-matroska"
	case ".webm":
		return "video/webm"
	case ".mp4", ".m4v", ".mov":
		return "video/mp4"
	case ".ts", ".m2ts":
		return "video/mp2t"
	default:
		if t := mime.TypeByExtension(ext); t != "" {
			return t
		}
		return "application/octet-stream"
	}
}

// @Summary  Stream a video file
// @Description Serves the raw bytes of a local (server omitted or 0) or remote video with HTTP Range support, for direct playback in the browser.
// @Tags     Player
// @Produce  octet-stream
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "File path"
// @Success  200 {file} binary
// @Success  206 {file} binary
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/stream [get]
func (s *Server) handlePlayStream(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.servePlayFile(w, r, src)
}

// writePlayErr reports a failure to reach or read the source: a remote one
// keeps the dial semantics (409 for a host key to review, 404, 502).
func writePlayErr(w http.ResponseWriter, src playSource, err error) {
	if src.serverID != 0 {
		writeDialErr(w, err)
		return
	}
	writeErr(w, http.StatusBadGateway, err.Error())
}

func (s *Server) servePlayFile(w http.ResponseWriter, r *http.Request, src playSource) {
	s.servePlayFileTracked(w, r, src, nil)
}

// servePlayFileTracked serves the file and, with a token, records how far into
// it the bytes actually got - the loopback's way of telling a run that read
// the whole file from one whose connection dropped half-way.
func (s *Server) servePlayFileTracked(w http.ResponseWriter, r *http.Request, src playSource, tok *loopToken) {
	f, err := s.openPlay(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	defer f.close()
	var body io.ReadSeeker = f.ReadSeeker
	if tok != nil {
		tok.size.Store(f.size)
		body = &trackedReader{ReadSeeker: f.ReadSeeker, tok: tok}
	}
	w.Header().Set("Content-Type", playMime(src.path))
	// a video is watched for longer than any write deadline the server might
	// one day get; streaming must not be cut off by it
	http.NewResponseController(w).SetWriteDeadline(time.Time{})
	http.ServeContent(w, r, "", f.modTime, body)
}

// trackedReader extends its token's coverage as bytes are read.
type trackedReader struct {
	io.ReadSeeker
	tok   *loopToken
	start int64 // where this stretch of reading began
	pos   int64
}

func (t *trackedReader) Read(p []byte) (int, error) {
	n, err := t.ReadSeeker.Read(p)
	t.pos += int64(n)
	t.tok.cover(t.start, t.pos)
	return n, err
}

func (t *trackedReader) Seek(offset int64, whence int) (int64, error) {
	pos, err := t.ReadSeeker.Seek(offset, whence)
	if err == nil {
		t.start, t.pos = pos, pos
	}
	return pos, err
}

// ── ffmpeg input ─────────────────────────────────────────────────────────────

// ffInput is how one ffmpeg run reads the source: a local file is handed over
// as fd 3 (so it never leaves its os.Root), a remote one as a loopback URL the
// process can seek through with Range requests.
type ffInput struct {
	url       string
	whitelist string
	// opts go ahead of -i: how a remote input survives a dropped connection
	opts  []string
	files []*os.File
	done  func()
	// complete reports whether a run read the source to its end; nil for a
	// local file, which cannot stop short
	complete func() bool
}

// remoteInputOpts let ffmpeg pick a remote read up where it broke off. The
// loopback answers with the file's length, so a stream that ends early is a
// disconnect to ffmpeg, not the end of the file - and it asks again from the
// byte it got to. A remote that is gone for good fails after a few tries.
var remoteInputOpts = []string{"-reconnect", "1", "-reconnect_on_network_error", "1",
	"-reconnect_on_http_error", "5xx", "-reconnect_max_retries", "8", "-reconnect_delay_max", "10"}

func (s *Server) ffInputFor(ctx context.Context, src playSource) (*ffInput, error) {
	if src.serverID == 0 {
		local, err := s.openLocal(src.path)
		if err != nil {
			return nil, err
		}
		f, err := local.Root.Open(local.Name)
		if err != nil {
			local.Close()
			return nil, err
		}
		return &ffInput{url: "/proc/self/fd/3", whitelist: "file,pipe", files: []*os.File{f},
			done: func() { f.Close(); local.Close() }}, nil
	}
	// dial once up front: inside ffmpeg an unknown host key or a dead server
	// would only ever surface as "could not read", never as itself
	f, err := s.openPlay(ctx, src)
	if err != nil {
		return nil, err
	}
	f.close()
	url, tok, release, err := s.loopbackURL(src)
	if err != nil {
		return nil, err
	}
	return &ffInput{url: url, whitelist: "http,tcp", opts: remoteInputOpts, done: release,
		complete: tok.whole}, nil
}

// playDemuxers are the containers and subtitle formats the player opens.
//
// ffmpeg picks the demuxer from a file's CONTENT, not its name: a ".mkv" that
// is really an HLS or concat playlist would have it open other paths (past the
// os.Root the file came through) or other hosts (through the loopback's http
// whitelist), and the transcode would hand what it read back to the user.
// Naming the demuxers closes that: a playlist format simply does not open.
const playDemuxers = "matroska,webm,mov,mp4,avi,mpegts,ass,srt,webvtt,sup,vobsub,microdvd,subviewer,subviewer1"

// ffCommand builds an ffmpeg/ffprobe run over in. before go ahead of -i (seek,
// probe options), after behind it.
func ffCommand(ctx context.Context, bin string, in *ffInput, before, after []string) *exec.Cmd {
	args := append([]string{"-hide_banner", "-v", "error",
		"-protocol_whitelist", in.whitelist, "-format_whitelist", playDemuxers}, in.opts...)
	args = append(args, before...)
	args = append(args, "-i", in.url)
	args = append(args, after...)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.ExtraFiles = in.files
	return cmd
}

// ── loopback: remote files for ffmpeg ────────────────────────────────────────

// playLoop serves remote sources to the ffmpeg processes on 127.0.0.1, each
// under a random token that lives only as long as the run that needs it. It is
// a listener of its own so the public mux never grows an unauthenticated route.
type playLoop struct {
	once   sync.Once
	addr   string
	err    error
	mu     sync.Mutex
	tokens map[string]*loopToken
}

// loopToken is one run's access to one source, and how much of it that run
// has read.
//
// Coverage counts only bytes read in one unbroken stretch from the start: the
// Matroska demuxer jumps to the index at the end of the file before it reads
// anything else, and a high-water mark would call that whole.
type loopToken struct {
	src     playSource
	size    atomic.Int64
	mu      sync.Mutex
	covered int64
}

// cover records that [from, to) was read; it counts when it joins on to what
// is already covered.
func (t *loopToken) cover(from, to int64) {
	t.mu.Lock()
	if from <= t.covered && to > t.covered {
		t.covered = to
	}
	t.mu.Unlock()
}

func (t *loopToken) whole() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := t.size.Load()
	return n > 0 && t.covered >= n
}

func (s *Server) loopbackURL(src playSource) (string, *loopToken, func(), error) {
	l := &s.playLoop
	l.once.Do(func() {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			l.err = err
			return
		}
		l.addr = ln.Addr().String()
		l.tokens = map[string]*loopToken{}
		go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			l.mu.Lock()
			tok, ok := l.tokens[path.Base(r.URL.Path)]
			l.mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			s.servePlayFileTracked(w, r, tok.src, tok)
		}))
	})
	if l.err != nil {
		return "", nil, nil, l.err
	}
	b := make([]byte, 16)
	rand.Read(b)
	key := hex.EncodeToString(b)
	tok := &loopToken{src: src}
	l.mu.Lock()
	l.tokens[key] = tok
	l.mu.Unlock()
	release := func() {
		l.mu.Lock()
		delete(l.tokens, key)
		l.mu.Unlock()
	}
	return "http://" + l.addr + "/t/" + key, tok, release, nil
}

// ── info ─────────────────────────────────────────────────────────────────────

// PlayTrack is one stream of the file, as the player's pickers show it.
type PlayTrack struct {
	Index    int    `json:"index"`
	Codec    string `json:"codec"`
	Lang     string `json:"lang,omitempty"`
	Title    string `json:"title,omitempty"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
	Channels int    `json:"channels,omitempty"`
	// Image marks a picture subtitle (PGS, VobSub, DVB): it cannot be rendered
	// as text. PGS goes out as SUP for the browser to draw (format=sup), the
	// others are burned into the transcoded picture
	Image bool `json:"image,omitempty"`
	// File is a sidecar subtitle beside the video; Index is -1 then
	File string `json:"file,omitempty"`
}

// PlayVideo is the picture stream of the file.
type PlayVideo struct {
	Codec   string `json:"codec"`
	Profile string `json:"profile,omitempty"`
	PixFmt  string `json:"pixFmt,omitempty"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

// PlayInfo is what the player needs to decide how to play a file.
type PlayInfo struct {
	Duration float64     `json:"duration"`
	Video    *PlayVideo  `json:"video,omitempty"`
	Audio    []PlayTrack `json:"audio"`
	Subs     []PlayTrack `json:"subs"`
	// Fonts are the stream indices of the font attachments, for /api/play/font
	Fonts []int `json:"fonts"`
}

var imageSubCodecs = map[string]bool{"hdmv_pgs_subtitle": true, "dvd_subtitle": true, "dvb_subtitle": true, "xsub": true}

// @Summary  Inspect a video for playback
// @Description Lists the duration, video, audio and subtitle tracks (including sidecar subtitle files) and font attachments of a local or remote video.
// @Tags     Player
// @Produce  json
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Success  200 {object} PlayInfo
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/info [get]
func (s *Server) handlePlayInfo(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := s.playInfo(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	// the fonts and the subtitle tracks start coming out of the file now, while
	// the picture loads: on a remote file the tracks take minutes
	if len(info.Fonts) > 0 || len(info.Subs) > 0 {
		s.startMediaJob(src, info)
	}
	info.Subs = append(info.Subs, s.sidecarTracks(src)...)
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) playInfo(ctx context.Context, src playSource) (PlayInfo, error) {
	info := PlayInfo{Audio: []PlayTrack{}, Subs: []PlayTrack{}, Fonts: []int{}}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	in, err := s.ffInputFor(ctx, src)
	if err != nil {
		return info, err
	}
	defer in.done()
	out, err := ffCommand(ctx, "ffprobe", in, []string{"-print_format", "json", "-show_streams", "-show_format"}, nil).Output()
	if err != nil {
		return info, errors.New("ffprobe could not read the file")
	}
	var probed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Index       int    `json:"index"`
			CodecType   string `json:"codec_type"`
			CodecName   string `json:"codec_name"`
			Profile     string `json:"profile"`
			PixFmt      string `json:"pix_fmt"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			Channels    int    `json:"channels"`
			Disposition struct {
				Default     int `json:"default"`
				Forced      int `json:"forced"`
				AttachedPic int `json:"attached_pic"`
			} `json:"disposition"`
			Tags struct {
				Language string `json:"language"`
				Title    string `json:"title"`
				Filename string `json:"filename"`
				Mimetype string `json:"mimetype"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &probed); err != nil {
		return info, err
	}
	info.Duration, _ = strconv.ParseFloat(probed.Format.Duration, 64)
	for _, st := range probed.Streams {
		t := PlayTrack{Index: st.Index, Codec: st.CodecName, Lang: langCode(st.Tags.Language), Title: st.Tags.Title,
			Default: st.Disposition.Default == 1, Forced: st.Disposition.Forced == 1, Channels: st.Channels}
		switch st.CodecType {
		case "video":
			// cover art rides along as a video stream too
			if info.Video == nil && st.Disposition.AttachedPic == 0 {
				info.Video = &PlayVideo{Codec: st.CodecName, Profile: st.Profile, PixFmt: st.PixFmt, Width: st.Width, Height: st.Height}
			}
		case "audio":
			info.Audio = append(info.Audio, t)
		case "subtitle":
			t.Image = imageSubCodecs[st.CodecName]
			info.Subs = append(info.Subs, t)
		case "attachment":
			if isFont(st.Tags.Mimetype, st.Tags.Filename) {
				info.Fonts = append(info.Fonts, st.Index)
			}
		}
	}
	return info, nil
}

func isFont(mimetype, filename string) bool {
	m := strings.ToLower(mimetype)
	if strings.Contains(m, "font") || strings.Contains(m, "truetype") || strings.Contains(m, "opentype") {
		return true
	}
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".ttf", ".otf", ".ttc", ".woff", ".woff2":
		return true
	}
	return false
}

// sidecarTracks lists the subtitle files beside the video that belong to it:
// same stem, a subtitle extension ("Show - 01.ger.ass", "Show - 01.srt").
func (s *Server) sidecarTracks(src playSource) []PlayTrack {
	dir, base := path.Split(src.path)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	var names []string
	if src.serverID == 0 {
		local, err := s.openLocal(dir)
		if err != nil {
			return nil
		}
		defer local.Close()
		d, err := local.Root.Open(local.Name)
		if err != nil {
			return nil
		}
		defer d.Close()
		items, _ := d.ReadDir(-1)
		for _, it := range items {
			names = append(names, it.Name())
		}
	} else {
		client, _, err := s.DialServer(src.userID, src.serverID)
		if err != nil {
			return nil
		}
		defer client.Close()
		entries, _ := client.List(dir)
		for _, e := range entries {
			names = append(names, e.Name)
		}
	}
	var out []PlayTrack
	for _, n := range names {
		if !transfer.SubExt[strings.ToLower(filepath.Ext(n))] || !strings.HasPrefix(n, stem) {
			continue
		}
		code, forced := sidecarLang(n)
		out = append(out, PlayTrack{Index: -1, Codec: strings.TrimPrefix(strings.ToLower(filepath.Ext(n)), "."),
			Lang: code, Forced: forced, Title: n, File: path.Join(dir, n)})
	}
	return out
}
