package api

import (
	"bytes"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// PlayStatus is how far the server has got with what the player waits for:
// the bytes read from a remote source, and the segment a transcode is on.
type PlayStatus struct {
	// Bytes read from the remote source by the runs open on it, and their
	// rate in bytes per second; 0 for a local file
	Bytes int64   `json:"bytes"`
	Rate  float64 `json:"rate"`
	// Done is the share of the awaited segment written (0-1), Left the
	// seconds still to go at the run's Speed (1 = as fast as playback); -1
	// when no segment is awaited or the number is not known yet
	Done  float64 `json:"done"`
	Left  float64 `json:"left"`
	Speed float64 `json:"speed"`
}

// @Summary  What the player waits for
// @Description How far the server has got with a file the player is opening: the bytes read from a remote source so far, and how much of the segment a transcode or repackaging is on is written. Polled while the player shows its loading state.
// @Tags     Player
// @Produce  json
// @Param    server query int    false "Server ID, 0 or omitted for a local file"
// @Param    path   query string true  "Video path"
// @Success  200 {object} PlayStatus
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/play/status [get]
func (s *Server) handlePlayStatus(w http.ResponseWriter, r *http.Request) {
	src, err := playSourceFrom(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	st := PlayStatus{Done: -1, Left: -1, Speed: -1}
	st.Bytes, st.Rate = s.playLoop.readOf(src)
	s.hls.progressOf(src, &st)
	writeJSON(w, http.StatusOK, st)
}

// readOf sums what the loopback served the open runs on src, and the rate
// since the oldest of them began.
func (l *playLoop) readOf(src playSource) (int64, float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var n int64
	var born time.Time
	for _, tok := range l.tokens {
		if tok.src != src {
			continue
		}
		n += tok.read.Load()
		if born.IsZero() || tok.born.Before(born) {
			born = tok.born
		}
	}
	if n == 0 {
		return 0, 0
	}
	return n, float64(n) / max(time.Since(born).Seconds(), 1)
}

// progressOf fills in the earliest segment a request waits on, from the run
// that is writing it.
func (h *hlsSessions) progressOf(src playSource, st *PlayStatus) {
	h.mu.Lock()
	var all []*hlsSession
	for k, sess := range h.all {
		if k.src == src {
			all = append(all, sess)
		}
	}
	h.mu.Unlock()
	for _, sess := range all {
		sess.mu.Lock()
		run, n := sess.run, -1
		for w := range sess.waiting {
			if n < 0 || w < n {
				n = w
			}
		}
		from, to, ok := sess.span(n)
		sess.mu.Unlock()
		if !ok || run == nil || !run.running() || n < run.start {
			continue
		}
		base, _, _ := sess.span(run.start)
		out, speed := run.prog.now()
		if out < 0 {
			st.Done = 0
			continue
		}
		at := out - (from - base)
		st.Done = min(max(at/(to-from), 0), 1)
		if speed > 0 {
			st.Speed = speed
			st.Left = max(to-base-out, 0) / speed
		}
		return
	}
}

// span is where segment n begins and ends in the source, in seconds; not ok
// for no segment, or the copy's last one, whose end the session does not keep.
func (sess *hlsSession) span(n int) (from, to float64, ok bool) {
	if n < 0 {
		return 0, 0, false
	}
	if sess.cuts == nil {
		return float64(n * hlsSegSec), float64((n + 1) * hlsSegSec), true
	}
	if n+1 >= len(sess.cuts) {
		return 0, 0, false
	}
	return sess.cuts[n], sess.cuts[n+1], true
}

// ffProgress reads ffmpeg's -progress lines: the output time it reached
// (from the run's start, without -output_ts_offset) and its speed.
type ffProgress struct {
	mu    sync.Mutex
	buf   []byte
	outUs atomic.Int64
	speed atomic.Uint64
	seen  atomic.Bool
}

func (p *ffProgress) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf = append(p.buf, b...)
	for {
		i := bytes.IndexByte(p.buf, '\n')
		if i < 0 {
			break
		}
		k, v, _ := strings.Cut(string(p.buf[:i]), "=")
		p.buf = p.buf[i+1:]
		v = strings.TrimSpace(v)
		switch k {
		case "out_time_us":
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
				p.outUs.Store(n)
				p.seen.Store(true)
			}
		case "speed":
			if f, err := strconv.ParseFloat(strings.TrimSuffix(v, "x"), 64); err == nil {
				p.speed.Store(math.Float64bits(f))
			}
		}
	}
	return len(b), nil
}

// now is the output time in seconds (-1 before ffmpeg reported any) and the
// speed (0 unknown).
func (p *ffProgress) now() (float64, float64) {
	if !p.seen.Load() {
		return -1, 0
	}
	return float64(p.outUs.Load()) / 1e6, math.Float64frombits(p.speed.Load())
}
