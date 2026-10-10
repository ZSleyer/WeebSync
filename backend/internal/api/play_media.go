package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/mkvsubs"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// What libass needs besides the picture: the text subtitle tracks as ASS and
// the fonts the file carries. Both come out of the file once, in the
// background, and are kept while the file is being watched.
//
// Once per file, because reading a subtitle track means reading the whole file
// - the track is interleaved with the picture from start to end. Over a remote
// connection that is minutes, longer than a proxy holds a quiet request open,
// and doing it again for every track the user switches to never finished at
// all. So a file gets one job: the info request starts a header read that
// dumps every font attachment, and the first subtitle request - which the
// player only sends once the picture plays, so the pass does not compete with
// its first reads - starts one pass that writes every text track. Requests
// only ever wait a little and otherwise say "not yet".
//
// A pass that did not get through the whole file (a remote that dropped and
// did not come back) is not kept: its tracks would end mid-episode. The job
// is dropped and the next request starts it again.

const (
	// how long a subtitle request waits for the pass before answering 202
	mediaSubWait = 15 * time.Second
	// the font dump reads only the header. libass fetches the fonts itself and
	// cannot ask again, so this waits - but under the 60 s a reverse proxy
	// gives a quiet request
	mediaFontWait = 25 * time.Second
	mediaJobsMax  = 6
	mediaJobIdle  = 30 * time.Minute
)

type mediaJob struct {
	src       playSource
	info      PlayInfo
	dir       string
	ctx       context.Context
	cancel    context.CancelFunc
	fontsDone chan struct{}
	subsOnce  sync.Once
	subsDone  chan struct{}
	// written before subsDone closes, read only after
	subsErr error
	mu      sync.Mutex
	last    time.Time
}

type mediaJobs struct {
	mu   sync.Mutex
	all  map[playSource]*mediaJob
	reap sync.Once
}

func (j *mediaJob) touch() {
	j.mu.Lock()
	j.last = time.Now()
	j.mu.Unlock()
}

func (j *mediaJob) idle() time.Duration {
	j.mu.Lock()
	defer j.mu.Unlock()
	return time.Since(j.last)
}

func (j *mediaJob) stop() {
	j.cancel()
	// a pass never started cannot finish: start it so it ends on the
	// cancelled context and the cleanup below is not left waiting
	j.subsOnce.Do(func() { close(j.subsDone) })
	go func() {
		<-j.fontsDone
		<-j.subsDone // the runs end once cancelled; their files go with them
		os.RemoveAll(j.dir)
	}()
}

// startMediaJob returns the file's job, starting it from what the info
// request measured if there is none yet.
func (s *Server) startMediaJob(src playSource, info PlayInfo) (*mediaJob, error) {
	h := &s.media
	h.reap.Do(func() { go h.reaper() })
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.all == nil {
		h.all = map[playSource]*mediaJob{}
	}
	if j, ok := h.all[src]; ok {
		j.touch()
		return j, nil
	}
	for len(h.all) >= mediaJobsMax {
		var oldest playSource
		var max time.Duration = -1
		for k, j := range h.all {
			if d := j.idle(); d > max {
				oldest, max = k, d
			}
		}
		h.all[oldest].stop()
		delete(h.all, oldest)
	}
	dir, err := os.MkdirTemp("", "wsmedia*")
	if err != nil {
		return nil, errors.New("no temp space")
	}
	// no deadline: a large file over a slow remote takes as long as it takes,
	// and an abandoned job ends by eviction
	ctx, cancel := context.WithCancel(context.Background())
	j := &mediaJob{src: src, info: info, dir: dir, ctx: ctx, cancel: cancel,
		fontsDone: make(chan struct{}), subsDone: make(chan struct{}), last: time.Now()}
	h.all[src] = j
	go s.dumpFonts(j)
	return j, nil
}

// dropMediaJob forgets a job whose result is not to be trusted, so the next
// request starts afresh.
func (s *Server) dropMediaJob(j *mediaJob) {
	s.media.mu.Lock()
	if s.media.all[j.src] == j {
		delete(s.media.all, j.src)
	}
	s.media.mu.Unlock()
	j.stop()
}

// mediaJobFor finds the job for a request, starting it (and the info read it
// needs) when the file has none, e.g. after a restart or an eviction.
func (s *Server) mediaJobFor(ctx context.Context, src playSource) (*mediaJob, error) {
	s.media.mu.Lock()
	j, ok := s.media.all[src]
	s.media.mu.Unlock()
	if ok {
		j.touch()
		return j, nil
	}
	info, err := s.playInfo(ctx, src)
	if err != nil {
		return nil, err
	}
	return s.startMediaJob(src, info)
}

func (h *mediaJobs) reaper() {
	for range time.Tick(time.Minute) {
		h.mu.Lock()
		for k, j := range h.all {
			if j.idle() > mediaJobIdle {
				j.stop()
				delete(h.all, k)
			}
		}
		h.mu.Unlock()
	}
}

// dumpFonts writes every font attachment in one header read.
func (s *Server) dumpFonts(j *mediaJob) {
	defer close(j.fontsDone)
	if len(j.info.Fonts) == 0 {
		return
	}
	bg := j.src
	bg.low = true
	in, err := s.ffInputFor(j.ctx, bg)
	if err != nil {
		return
	}
	defer in.done()
	before := []string{"-y"}
	for _, n := range j.info.Fonts {
		before = append(before, "-dump_attachment:"+strconv.Itoa(n), filepath.Join(j.dir, strconv.Itoa(n)+".font"))
	}
	// no output: ffmpeg stops right after opening the input; it exits
	// non-zero by design, the files are the answer
	ffCommand(j.ctx, "ffmpeg", in, before, []string{"-t", "0", "-f", "null", "-"}).Run()
}

// startSubs runs the subtitle pass once per job.
func (s *Server) startSubs(j *mediaJob) {
	j.subsOnce.Do(func() { go s.extractSubs(j) })
}

// extractSubs writes every text track. A Matroska file that indexes its
// subtitle blocks gives them up in a few hundred small reads (mkvsubs); any
// other file is read once from end to end by ffmpeg. That pass yields the
// remote connections to the picture, and it only counts when the whole file
// went through.
func (s *Server) extractSubs(j *mediaJob) {
	defer close(j.subsDone)
	began := time.Now()
	if strings.EqualFold(filepath.Ext(j.src.path), ".mkv") {
		n, err := s.sparseSubs(j)
		if err == nil {
			slog.Info("player subtitles", "path", logSafe(j.src.path), "way", "cues", "tracks", n, "took", time.Since(began).Round(time.Millisecond))
			return
		}
		if j.ctx.Err() != nil {
			j.subsErr = errors.New("the subtitle pass was stopped")
			return
		}
		slog.Info("player subtitles", "path", logSafe(j.src.path), "way", "cues", "skipped", err)
	}
	defer func() {
		slog.Info("player subtitles", "path", logSafe(j.src.path), "way", "full read", "took", time.Since(began).Round(time.Millisecond), "failed", j.subsErr != nil)
	}()
	var after []string
	for _, t := range j.info.Subs {
		if t.Index >= 0 && !t.Image {
			n := strconv.Itoa(t.Index)
			after = append(after, "-map", "0:"+n, "-c:s", "ass", filepath.Join(j.dir, n+".ass"))
		}
	}
	if len(after) == 0 {
		return
	}
	bg := j.src
	bg.low = true
	in, err := s.ffInputFor(j.ctx, bg)
	if err != nil {
		j.subsErr = errors.New("the subtitle tracks could not be read")
		return
	}
	defer in.done()
	var stderr strings.Builder
	cmd := ffCommand(j.ctx, "ffmpeg", in, []string{"-y"}, after)
	cmd.Stderr = &stderr
	err = cmd.Run()
	if j.ctx.Err() != nil {
		j.subsErr = errors.New("the subtitle pass was stopped")
		return
	}
	if err == nil && in.complete != nil && !in.complete() {
		err = errors.New("the connection ended before the end of the file")
	}
	if err != nil {
		slog.Warn("player subtitles", "path", logSafe(j.src.path), "err", err, "ffmpeg", logSafe(stderr.String()))
		j.subsErr = errors.New("the subtitle tracks could not be read")
	}
}

// sparseSubs reads the text tracks through the file's Cues and writes them
// into the job; n is how many it wrote.
func (s *Server) sparseSubs(j *mediaJob) (n int, err error) {
	bg := j.src
	bg.low = true
	ra, size, done, err := s.readerAt(j.ctx, bg)
	if err != nil {
		return 0, err
	}
	defer done()
	subs, err := mkvsubs.Read(ra, size, 8)
	if err != nil {
		return 0, err
	}
	for _, t := range j.info.Subs {
		if t.Index < 0 || t.Image || t.Index >= len(subs.Tracks) || !subs.Tracks[t.Index].Text {
			continue
		}
		// ffprobe numbers a Matroska file's streams in the order of its tracks
		if err := os.WriteFile(filepath.Join(j.dir, strconv.Itoa(t.Index)+".ass"), []byte(subs.ASS(subs.Tracks[t.Index])), 0o600); err != nil {
			return 0, err
		}
		n++
	}
	return n, nil
}

// readerAt opens the source for reads at any offset. A local file is one; an
// SFTP file is one too, and serves the reads in parallel on a single
// handle. Anything else (FTP) reads each range on its own transfer.
func (s *Server) readerAt(ctx context.Context, src playSource) (io.ReaderAt, int64, func(), error) {
	if src.serverID == 0 {
		local, err := s.openLocal(src.path)
		if err != nil {
			return nil, 0, nil, err
		}
		f, err := local.Root.Open(local.Name)
		if err != nil {
			local.Close()
			return nil, 0, nil, err
		}
		fi, err := f.Stat()
		if err != nil {
			f.Close()
			local.Close()
			return nil, 0, nil, err
		}
		return f, fi.Size(), func() { f.Close(); local.Close() }, nil
	}
	pf, err := s.openPlay(ctx, src)
	if err != nil {
		return nil, 0, nil, err
	}
	rf := pf.ReadSeeker.(*remoteFile)
	rc, err := rf.c.Open(rf.path, 0)
	if err != nil {
		pf.close()
		return nil, 0, nil, err
	}
	if ra, ok := rc.(io.ReaderAt); ok {
		return ra, pf.size, func() { rc.Close(); pf.close() }, nil
	}
	rc.Close()
	return &rangeReader{c: rf.c, path: rf.path}, pf.size, pf.close, nil
}

// rangeReader reads a range at a time through Open(path, offset), one at a
// time: a client without random access cannot serve two at once.
type rangeReader struct {
	mu   sync.Mutex
	c    remote.Client
	path string
}

func (r *rangeReader) ReadAt(p []byte, off int64) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rc, err := r.c.Open(r.path, off)
	if err != nil {
		return 0, err
	}
	defer rc.Close()
	return io.ReadFull(rc, p)
}

// SubPending is the answer while the subtitle pass is still reading the file.
type SubPending struct {
	Status string `json:"status" example:"pending"`
}

// @Summary  Subtitle track as ASS
// @Description Returns one text subtitle track of the video as ASS for the browser's libass renderer, or a sidecar subtitle file (passed as path) converted to ASS. Embedded tracks come from a background pass over the whole file that the info request starts; until it is done the answer is 202 and the client asks again.
// @Tags     Player
// @Produce  plain
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video or sidecar subtitle path"
// @Param    track  query int    false "Stream index of an embedded subtitle; omitted for a sidecar file"
// @Success  200 {string} string
// @Success  202 {object} SubPending
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/sub [get]
func (s *Server) handlePlaySub(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if transfer.SubExt[strings.ToLower(filepath.Ext(src.path))] {
		s.serveSidecarSub(w, r, src)
		return
	}
	n, err := strconv.Atoi(r.URL.Query().Get("track"))
	if err != nil || n < 0 {
		writeErr(w, http.StatusBadRequest, "invalid track")
		return
	}
	j, err := s.mediaJobFor(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	s.startSubs(j)
	select {
	case <-j.subsDone:
	case <-time.After(mediaSubWait):
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusAccepted, SubPending{Status: "pending"})
		return
	case <-r.Context().Done():
		return
	}
	if j.subsErr != nil {
		// a broken pass is not kept: asking again starts a new one
		s.dropMediaJob(j)
		writeErr(w, http.StatusBadGateway, j.subsErr.Error())
		return
	}
	b, err := os.ReadFile(filepath.Join(j.dir, strconv.Itoa(n)+".ass"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "no text subtitle track with that index")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(b)
}

// serveSidecarSub converts a subtitle file beside the video. It is small and
// read on its own, so it is answered in place.
func (s *Server) serveSidecarSub(w http.ResponseWriter, r *http.Request, src playSource) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	in, err := s.ffInputFor(ctx, src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	defer in.done()
	out, err := ffCommand(ctx, "ffmpeg", in, nil, []string{"-map", "0:s:0", "-c:s", "ass", "-f", "ass", "pipe:1"}).Output()
	if err != nil {
		slog.Warn("player subtitle", "path", logSafe(src.path), "err", err)
		writeErr(w, http.StatusBadGateway, "the subtitle file could not be read")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}

// @Summary  Font attachment
// @Description Returns one font attachment of the video, for rendering its ASS subtitles. All attachments come out of one header read in the background job the info request starts.
// @Tags     Player
// @Produce  octet-stream
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Param    index  query int    true  "Stream index of the attachment"
// @Success  200 {file} binary
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Failure  504 {object} ErrorResponse
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
	j, err := s.mediaJobFor(r.Context(), src)
	if err != nil {
		writePlayErr(w, src, err)
		return
	}
	select {
	case <-j.fontsDone:
	case <-time.After(mediaFontWait):
		writeErr(w, http.StatusGatewayTimeout, "the fonts are still being read")
		return
	case <-r.Context().Done():
		return
	}
	b, err := os.ReadFile(filepath.Join(j.dir, strconv.Itoa(n)+".font"))
	if err != nil || len(b) == 0 {
		if slices.Contains(j.info.Fonts, n) {
			// an attachment the file has did not come out: the header read
			// broke off, so the next look tries again
			s.dropMediaJob(j)
			writeErr(w, http.StatusBadGateway, "the font could not be read")
			return
		}
		writeErr(w, http.StatusNotFound, "no font attachment with that index")
		return
	}
	// the same file for the whole session: let the browser keep it
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(b)
}
