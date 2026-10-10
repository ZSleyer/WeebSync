package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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
	client, _, err := s.dialServer(ctx, src.userID, src.serverID, pool.PriHigh)
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
	f, err := s.openPlay(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	defer f.close()
	w.Header().Set("Content-Type", playMime(src.path))
	// a video is watched for longer than any write deadline the server might
	// one day get; streaming must not be cut off by it
	http.NewResponseController(w).SetWriteDeadline(time.Time{})
	http.ServeContent(w, r, "", f.modTime, f.ReadSeeker)
}

// ── ffmpeg input ─────────────────────────────────────────────────────────────

// ffInput is how one ffmpeg run reads the source: a local file is handed over
// as fd 3 (so it never leaves its os.Root), a remote one as a loopback URL the
// process can seek through with Range requests.
type ffInput struct {
	url       string
	whitelist string
	files     []*os.File
	done      func()
}

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
	url, release, err := s.loopbackURL(src)
	if err != nil {
		return nil, err
	}
	return &ffInput{url: url, whitelist: "http,tcp", done: release}, nil
}

// ffCommand builds an ffmpeg/ffprobe run over in. before go ahead of -i (seek,
// probe options), after behind it.
func ffCommand(ctx context.Context, bin string, in *ffInput, before, after []string) *exec.Cmd {
	args := append([]string{"-hide_banner", "-v", "error", "-protocol_whitelist", in.whitelist}, before...)
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
	tokens map[string]playSource
}

func (s *Server) loopbackURL(src playSource) (string, func(), error) {
	l := &s.playLoop
	l.once.Do(func() {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			l.err = err
			return
		}
		l.addr = ln.Addr().String()
		l.tokens = map[string]playSource{}
		go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			l.mu.Lock()
			src, ok := l.tokens[path.Base(r.URL.Path)]
			l.mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			s.servePlayFile(w, r, src)
		}))
	})
	if l.err != nil {
		return "", nil, l.err
	}
	b := make([]byte, 16)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	l.mu.Lock()
	l.tokens[tok] = src
	l.mu.Unlock()
	release := func() {
		l.mu.Lock()
		delete(l.tokens, tok)
		l.mu.Unlock()
	}
	return "http://" + l.addr + "/t/" + tok, release, nil
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
	// as text and is burned into the transcoded picture instead
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

// ── subtitles and fonts ──────────────────────────────────────────────────────

// @Summary  Subtitle track as ASS
// @Description Converts one text subtitle track of the video (or a sidecar subtitle file passed as path) to ASS for the browser's libass renderer. Reading an embedded track reads the whole file.
// @Tags     Player
// @Produce  plain
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video or sidecar subtitle path"
// @Param    track  query int    false "Stream index of an embedded subtitle; omitted for a sidecar file"
// @Success  200 {string} string
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/sub [get]
func (s *Server) handlePlaySub(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	mapArg := "0:s:0"
	if v := r.URL.Query().Get("track"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeErr(w, http.StatusBadRequest, "invalid track")
			return
		}
		mapArg = "0:" + strconv.Itoa(n)
	}
	// an embedded track is interleaved through the whole file, so this reads
	// all of it; a remote one is a full download and gets the time for it
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	in, err := s.ffInputFor(ctx, src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	defer in.done()
	// ponytail: no cache - a remote track is pulled again on every open; cache
	// by (server, path, size) once that turns out to hurt
	out, err := ffCommand(ctx, "ffmpeg", in, nil,
		[]string{"-map", mapArg, "-c:s", "ass", "-f", "ass", "pipe:1"}).Output()
	if err != nil {
		slog.Warn("player subtitle", "path", logSafe(src.path), "err", err)
		writeErr(w, http.StatusBadGateway, "the subtitle track could not be read")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}

// @Summary  Font attachment
// @Description Returns one font attachment of the video, for rendering its ASS subtitles.
// @Tags     Player
// @Produce  octet-stream
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Param    index  query int    true  "Stream index of the attachment"
// @Success  200 {file} binary
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/font [get]
func (s *Server) handlePlayFont(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || n < 0 {
		writeErr(w, http.StatusBadRequest, "invalid index")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	in, err := s.ffInputFor(ctx, src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	defer in.done()
	tmp, err := os.CreateTemp("", "wsfont*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "no temp space")
		return
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	// attachments sit in the header: no output, ffmpeg stops right after
	// opening the input
	err = ffCommand(ctx, "ffmpeg", in, []string{"-y", "-dump_attachment:" + strconv.Itoa(n), tmp.Name()},
		[]string{"-t", "0", "-f", "null", "-"}).Run()
	b, rerr := os.ReadFile(tmp.Name())
	if err != nil || rerr != nil || len(b) == 0 {
		writeErr(w, http.StatusBadGateway, "the font could not be read")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(b)
}
