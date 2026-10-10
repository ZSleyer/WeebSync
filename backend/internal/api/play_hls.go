package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The transcoding path. The playlist is written up front for the whole file,
// in fixed hlsSegSec slices, so the browser sees the real duration and can
// seek anywhere. One ffmpeg run per session fills the segments from where
// playback is; a request far from what that run has produced restarts it at
// the requested segment. Keyframes are forced onto the slice grid and every
// run is offset to its start time, so segments from different runs line up.

const (
	hlsSegSec = 6
	// a request this many segments past what the current run has written
	// restarts the run there instead of waiting for it to arrive
	hlsAheadSegs = 4
	// sessions are rebuilt on demand from their URL, so an idle one can go
	hlsIdle = 2 * time.Minute
	// each session is an ffmpeg encoding at full speed; the oldest makes room
	hlsMaxSessions = 3
)

type hlsKey struct {
	src   playSource
	audio int // stream index, -1 = none
	burn  int // stream index of a picture subtitle to burn in, -1 = none
	// copy: the picture is passed through (see play_copy.go); acopy: the
	// sound too, else it becomes AAC
	copy, acopy bool
}

type hlsSession struct {
	key  hlsKey
	dir  string
	mu   sync.Mutex
	last time.Time
	run  *hlsRun // the current ffmpeg run, nil before the first
	// the copy mode's segment starts, in seconds
	cuts []float64
}

// hlsRun is one ffmpeg process. err is written before exited closes and read
// only after, so it needs no lock.
type hlsRun struct {
	start  int // first segment it writes
	cancel context.CancelFunc
	exited chan struct{}
	err    error
}

func (r *hlsRun) running() bool {
	select {
	case <-r.exited:
		return false
	default:
		return true
	}
}

type hlsSessions struct {
	mu   sync.Mutex
	all  map[hlsKey]*hlsSession
	reap sync.Once
}

func hlsKeyFrom(r *http.Request) (hlsKey, error) {
	src, err := playSourceFrom(r)
	if err != nil {
		return hlsKey{}, err
	}
	k := hlsKey{src: src, audio: -1, burn: -1}
	q := r.URL.Query()
	k.copy, k.acopy = q.Get("copy") == "1", q.Get("acopy") == "1"
	for name, dst := range map[string]*int{"audio": &k.audio, "burn": &k.burn} {
		if v := q.Get(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < -1 {
				return k, errors.New("invalid " + name)
			}
			*dst = n
		}
	}
	return k, nil
}

// @Summary  HLS playlist for transcoded playback
// @Description Playlist of the whole video in fixed segments; the segments are transcoded to H.264/AAC on demand. audio picks the audio stream, burn a picture subtitle stream to burn into the image.
// @Tags     Player
// @Produce  plain
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Param    audio  query int    false "Audio stream index"
// @Param    burn   query int    false "Picture subtitle stream index to burn in"
// @Param    copy   query int    false "1: copy the picture and only repackage it (cut at the file's keyframes); falls back to transcoding without a keyframe index"
// @Param    acopy  query int    false "1: copy the sound too (with copy=1)"
// @Success  200 {string} string
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/hls/index.m3u8 [get]
func (s *Server) handlePlayHLSIndex(w http.ResponseWriter, r *http.Request) {
	key, err := hlsKeyFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	src, _ := playSourceFrom(r)
	info, err := s.playInfo(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	if info.Duration <= 0 {
		writeErr(w, http.StatusBadGateway, "the duration could not be read")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	q := r.URL.Query()
	if key.copy {
		if cuts := s.copyCuts(r.Context(), src); cuts != nil {
			w.Write([]byte(copyPlaylist(cuts, info.Duration, q)))
			return
		}
		// no keyframe index to cut a copy at: this file is transcoded, and
		// its segment URLs say so
		q.Del("copy")
		q.Del("acopy")
	}
	w.Write([]byte(hlsPlaylist(info.Duration, q)))
}

// hlsPlaylist lists every segment of a file of the given length. The segment
// URLs carry the same query as the playlist, so a segment request alone is
// enough to rebuild its session.
func hlsPlaylist(duration float64, q url.Values) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n", hlsSegSec+1)
	n := int(math.Ceil(duration / hlsSegSec))
	for i := range n {
		d := math.Min(hlsSegSec, duration-float64(i*hlsSegSec))
		q.Set("n", strconv.Itoa(i))
		fmt.Fprintf(&b, "#EXTINF:%.3f,\nseg.ts?%s\n", d, q.Encode())
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return b.String()
}

// @Summary  HLS segment
// @Description One transcoded MPEG-TS segment of the playlist from /api/play/hls/index.m3u8.
// @Tags     Player
// @Produce  octet-stream
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Param    audio  query int    false "Audio stream index"
// @Param    burn   query int    false "Picture subtitle stream index to burn in"
// @Param    copy   query int    false "1: copy the picture and only repackage it (cut at the file's keyframes); falls back to transcoding without a keyframe index"
// @Param    acopy  query int    false "1: copy the sound too (with copy=1)"
// @Param    n      query int    true  "Segment number"
// @Success  200 {file} binary
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Failure  504 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/hls/seg.ts [get]
func (s *Server) handlePlayHLSSegment(w http.ResponseWriter, r *http.Request) {
	key, err := hlsKeyFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := strconv.Atoi(r.URL.Query().Get("n"))
	if err != nil || n < 0 {
		writeErr(w, http.StatusBadRequest, "invalid segment")
		return
	}
	var cuts []float64
	if key.copy {
		if cuts = s.copyCuts(r.Context(), key.src); cuts == nil || n >= len(cuts) {
			writeErr(w, http.StatusBadGateway, "the file has no keyframe index to cut at")
			return
		}
	}
	sess, err := s.hlsSession(key, cuts)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	file, err := sess.segment(r.Context(), s, n)
	if err != nil {
		writePlayErr(w, key.src, err)
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	http.ServeFile(w, r, file)
}

func (s *Server) hlsSession(key hlsKey, cuts []float64) (*hlsSession, error) {
	h := &s.hls
	h.reap.Do(func() { go h.reaper() })
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.all == nil {
		h.all = map[hlsKey]*hlsSession{}
	}
	if sess, ok := h.all[key]; ok {
		return sess, nil
	}
	for len(h.all) >= hlsMaxSessions {
		var oldest *hlsSession
		for _, sess := range h.all {
			if oldest == nil || sess.lastUsed().Before(oldest.lastUsed()) {
				oldest = sess
			}
		}
		delete(h.all, oldest.key)
		oldest.stop()
	}
	dir, err := os.MkdirTemp("", "wshls*")
	if err != nil {
		return nil, errors.New("no temp space")
	}
	sess := &hlsSession{key: key, dir: dir, last: time.Now(), cuts: cuts}
	h.all[key] = sess
	return sess, nil
}

func (h *hlsSessions) reaper() {
	for range time.Tick(30 * time.Second) {
		h.mu.Lock()
		for k, sess := range h.all {
			if time.Since(sess.lastUsed()) > hlsIdle {
				delete(h.all, k)
				sess.stop()
			}
		}
		h.mu.Unlock()
	}
}

func (sess *hlsSession) lastUsed() time.Time {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.last
}

// stop ends the run and drops the segments.
func (sess *hlsSession) stop() {
	sess.mu.Lock()
	sess.killLocked()
	sess.mu.Unlock()
	os.RemoveAll(sess.dir)
}

func (sess *hlsSession) killLocked() {
	if sess.run != nil {
		sess.run.cancel()
		<-sess.run.exited
	}
}

func (sess *hlsSession) segPath(n int) string {
	return filepath.Join(sess.dir, strconv.Itoa(n)+".ts")
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ready reports whether segment n is complete.
func (sess *hlsSession) ready(n int) bool {
	if !sess.key.copy {
		return exists(sess.segPath(n))
	}
	list, err := os.ReadFile(filepath.Join(sess.dir, "list.csv"))
	return err == nil && strings.Contains("\n"+string(list), "\n"+strconv.Itoa(n)+".ts,")
}

// segment returns the file of segment n once it is written, starting or
// moving the ffmpeg run when n is not on its way.
func (sess *hlsSession) segment(ctx context.Context, s *Server, n int) (string, error) {
	p := sess.segPath(n)
	sess.mu.Lock()
	sess.last = time.Now()
	if !sess.ready(n) {
		run := sess.run
		if run == nil || !run.running() || n < run.start || n > sess.written(run.start)+hlsAheadSegs {
			if err := sess.runLocked(s, n); err != nil {
				sess.mu.Unlock()
				return "", err
			}
		}
	}
	sess.mu.Unlock()

	// a slow host or a remote source can take a while for the first segment
	deadline := time.After(90 * time.Second)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if sess.ready(n) {
			return p, nil
		}
		sess.mu.Lock()
		run := sess.run
		sess.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline:
			return "", errors.New("the segment took too long to transcode")
		case <-run.exited:
			// the run ended: either it wrote the segment just now or never will
			if sess.ready(n) {
				return p, nil
			}
			if run.err != nil {
				return "", run.err
			}
			sess.mu.Lock()
			if sess.run == run { // nobody restarted it meanwhile
				sess.mu.Unlock()
				return "", errors.New("the transcode stopped before this segment")
			}
			sess.mu.Unlock()
		case <-tick.C:
		}
	}
}

// runLocked (re)starts ffmpeg at segment n.
func (sess *hlsSession) runLocked(s *Server, n int) error {
	sess.killLocked()
	ctx, cancel := context.WithCancel(context.Background())
	in, err := s.ffInputFor(ctx, sess.key.src)
	if err != nil {
		cancel()
		return err
	}
	start, out := strconv.Itoa(n*hlsSegSec), hlsArgs(sess.key, n, sess.dir)
	if sess.key.copy {
		start, out = strconv.FormatFloat(sess.cuts[n], 'f', 3, 64), copyArgs(sess.key, sess.cuts, n, sess.dir)
	}
	cmd := ffCommand(ctx, "ffmpeg", in, []string{"-nostdin", "-ss", start}, out)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		in.done()
		cancel()
		return errors.New("ffmpeg could not be started")
	}
	run := &hlsRun{start: n, cancel: cancel, exited: make(chan struct{})}
	sess.run = run
	go func() {
		err := cmd.Wait()
		in.done()
		if err != nil && ctx.Err() == nil {
			slog.Warn("player transcode", "path", logSafe(sess.key.src.path), "err", err, "ffmpeg", logSafe(stderr.String()))
			run.err = errors.New("the transcode failed")
		}
		close(run.exited)
	}()
	return nil
}

// written is the first segment from start on that is not on disk yet.
func (sess *hlsSession) written(start int) int {
	for sess.ready(start) {
		start++
	}
	return start
}

// hlsArgs is the output side of a run starting at segment n: H.264 at most
// 1080 lines high in 8 bit (what every browser decodes), stereo AAC, keyframes
// on the segment grid, timestamps offset to the run's start.
//
// ponytail: software x264 only; a picture the browser can show is copied
// instead (play_copy.go). Hardware encoders are the upgrade path where a host
// has one.
func hlsArgs(k hlsKey, n int, dir string) []string {
	scale := "scale=-2:'min(1080,ih)',format=yuv420p"
	var args []string
	if k.burn >= 0 {
		args = append(args, "-filter_complex",
			fmt.Sprintf("[0:v:0][0:%d]overlay=eof_action=pass,%s[v]", k.burn, scale), "-map", "[v]")
	} else {
		args = append(args, "-map", "0:v:0", "-vf", scale)
	}
	if k.audio >= 0 {
		args = append(args, "-map", "0:"+strconv.Itoa(k.audio))
	} else {
		args = append(args, "-map", "0:a:0?")
	}
	off := strconv.Itoa(n * hlsSegSec)
	return append(args,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", hlsSegSec),
		"-c:a", "aac", "-ac", "2", "-b:a", "192k",
		"-f", "hls", "-hls_time", strconv.Itoa(hlsSegSec), "-hls_list_size", "0",
		"-hls_segment_type", "mpegts", "-hls_flags", "temp_file",
		"-start_number", strconv.Itoa(n), "-output_ts_offset", off,
		"-muxdelay", "0", "-muxpreload", "0",
		"-hls_segment_filename", filepath.Join(dir, "%d.ts"), filepath.Join(dir, "run.m3u8"))
}
