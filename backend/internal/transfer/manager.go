// Package transfer runs the download queue: worker pool, throttling,
// resume, sync and SSE progress events.
package transfer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
	"golang.org/x/time/rate"
)

// Dialer opens a connection for a user's stored server config.
type Dialer func(userID, serverID int64) (remote.Client, string, error)

type Download struct {
	ID          int64  `json:"id"`
	UserID      int64  `json:"userId"`
	ServerID    int64  `json:"serverId"`
	RemotePath  string `json:"remotePath"`
	LocalPath   string `json:"localPath"`
	Size        int64  `json:"size"`
	Transferred int64  `json:"transferred"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	RateLimit   int64  `json:"rateLimit"`
	BytesPerSec int64  `json:"bytesPerSec,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

type running struct {
	userID  int64 // owner, so the in-memory pause/cancel path stays user-scoped
	cancel  context.CancelFunc
	paused  bool // pause vs. hard cancel, checked when the ctx fires
	limiter *rate.Limiter
	bps     int64 // last measured rate, for the aggregate status endpoint
}

type Manager struct {
	DB           *sql.DB
	Dial         Dialer
	DownloadRoot string
	// OnFinished is called when a download reaches done/error (for push
	// notifications); may be nil.
	OnFinished func(d *Download)

	global *rate.Limiter

	mu       sync.Mutex
	active   map[int64]*running
	subs     map[chan string]struct{}
	wake     chan struct{}
	maxConc  int
	stopping bool
	wg       sync.WaitGroup
}

func NewManager(db *sql.DB, dial Dialer, downloadRoot string) *Manager {
	m := &Manager{
		DB: db, Dial: dial, DownloadRoot: downloadRoot,
		active: map[int64]*running{},
		subs:   map[chan string]struct{}{},
		wake:   make(chan struct{}, 1),
	}
	m.reloadSettings()
	// crashed mid-transfer? back to the queue
	db.Exec(`UPDATE downloads SET status = 'queued' WHERE status = 'running'`)
	go m.loop()
	return m
}

// ── settings ────────────────────────────────────────────────

func (m *Manager) setting(key string, def int64) int64 {
	var v string
	if err := m.DB.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); err != nil {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

func (m *Manager) reloadSettings() {
	conc := m.setting("max_concurrent", 3)
	limit := m.setting("global_rate_limit", 0)
	m.mu.Lock()
	m.maxConc = int(conc)
	if limit <= 0 {
		m.global = nil
	} else if m.global == nil {
		m.global = newLimiter(limit)
	} else {
		m.global.SetLimit(rate.Limit(limit))
		m.global.SetBurst(max(int(limit), 32*1024))
	}
	m.mu.Unlock()
}

// SettingsChanged is called by the API after settings writes.
func (m *Manager) SettingsChanged() {
	m.reloadSettings()
	m.Wake()
}

func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// ── queue loop ──────────────────────────────────────────────

func (m *Manager) loop() {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-m.wake:
		case <-tick.C:
		}
		m.startPending()
	}
}

func (m *Manager) startPending() {
	m.mu.Lock()
	free := m.maxConc - len(m.active)
	stopping := m.stopping
	m.mu.Unlock()
	if stopping || free <= 0 {
		return
	}
	rows, err := m.DB.Query(`SELECT id FROM downloads WHERE status = 'queued' ORDER BY id LIMIT ?`, free)
	if err != nil {
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		m.startDownload(id)
	}
}

func (m *Manager) startDownload(id int64) {
	d, err := m.get(id)
	if err != nil {
		return
	}
	// re-check: the user may have paused/canceled between the queue query
	// and now - starting anyway would resurrect the download
	if d.Status != "queued" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{userID: d.UserID, cancel: cancel, limiter: newLimiter(d.RateLimit)}
	m.mu.Lock()
	if _, dup := m.active[id]; dup {
		m.mu.Unlock()
		cancel()
		return
	}
	m.active[id] = r
	m.mu.Unlock()

	m.setStatus(id, "running", "")
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		err := m.runDownload(ctx, d, r)
		m.mu.Lock()
		paused := r.paused
		stopping := m.stopping
		delete(m.active, id)
		m.mu.Unlock()
		switch {
		case err == nil:
			m.setStatus(id, "done", "")
		case paused:
			m.setStatus(id, "paused", "")
		case stopping && ctx.Err() != nil:
			// graceful shutdown: back to the queue, resumes from .part on restart
			m.setStatus(id, "queued", "")
		case ctx.Err() != nil:
			m.setStatus(id, "canceled", "")
		default:
			slog.Warn("download failed", "id", id, "err", err)
			m.setStatus(id, "error", err.Error())
		}
		m.Wake()
	}()
}

func (m *Manager) runDownload(ctx context.Context, d *Download, r *running) error {
	client, _, err := m.Dial(d.UserID, d.ServerID)
	if err != nil {
		return err
	}
	defer client.Close()

	size, err := client.Size(d.RemotePath)
	if err != nil {
		return err
	}
	m.DB.Exec(`UPDATE downloads SET size = ? WHERE id = ?`, size, d.ID)
	d.Size = size

	// self-heal a stale queue: a watch check runs minutes before its downloads
	// drain, and one that ran while the target disk was unmounted queues every
	// episode as "missing". By download time the disk is usually back and the
	// file is already present at full size - don't refetch over a good file.
	// A genuine new episode or a re-release (E15v2, different size) still fails
	// this check and downloads normally.
	if alreadyComplete(d.LocalPath, size) {
		m.DB.Exec(`UPDATE downloads SET transferred = ? WHERE id = ?`, size, d.ID)
		return nil
	}

	part := d.LocalPath + ".part"
	if err := os.MkdirAll(filepath.Dir(part), 0o755); err != nil {
		return err
	}
	var offset int64
	if fi, err := os.Stat(part); err == nil {
		offset = fi.Size()
	}
	if offset > size {
		offset = 0 // remote file changed, start over
		if err := os.Truncate(part, 0); err != nil {
			return err
		}
	}

	src, err := client.Open(d.RemotePath, offset)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer dst.Close()

	// fetched per Read under mu: SetRateLimit and reloadSettings swap these
	// pointers concurrently (including nil ↔ *Limiter transitions)
	reader := &throttledReader{r: src, ctx: ctx, limiters: func() []*rate.Limiter {
		m.mu.Lock()
		defer m.mu.Unlock()
		return []*rate.Limiter{m.global, r.limiter}
	}}

	transferred := offset
	lastReport := time.Now()
	lastBytes := transferred
	buf := make([]byte, 128*1024)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, rerr := reader.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			transferred += int64(n)
		}
		if now := time.Now(); now.Sub(lastReport) >= time.Second {
			bps := int64(float64(transferred-lastBytes) / now.Sub(lastReport).Seconds())
			lastReport, lastBytes = now, transferred
			m.DB.Exec(`UPDATE downloads SET transferred = ?, updated_at = datetime('now') WHERE id = ?`, transferred, d.ID)
			m.mu.Lock()
			r.bps = bps
			m.mu.Unlock()
			d.Transferred, d.BytesPerSec, d.Status = transferred, bps, "running"
			m.publish(d)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if err := dst.Sync(); err != nil {
		return err
	}
	m.DB.Exec(`UPDATE downloads SET transferred = ? WHERE id = ?`, transferred, d.ID)
	// a dropped connection can surface as plain EOF (FTP data channel):
	// never rename a short file into place as if it were complete
	if transferred < size {
		return fmt.Errorf("incomplete transfer: %d of %d bytes", transferred, size)
	}
	return os.Rename(part, d.LocalPath)
}

// ── public API used by handlers ─────────────────────────────

var ErrNotFound = fmt.Errorf("download not found")

// VideoExt lists file extensions treated as episodes (upload guard,
// completeness checks).
var VideoExt = map[string]bool{".mkv": true, ".mp4": true, ".avi": true, ".ts": true, ".m2ts": true, ".webm": true, ".mov": true}

// alreadyComplete reports whether the final file is already present at the
// exact remote size, so a queued download can be skipped instead of refetched
// over a good file (stale queue from a check that ran while the disk was
// unmounted). A re-release with a different size fails this and downloads.
func alreadyComplete(localPath string, size int64) bool {
	fi, err := os.Stat(localPath)
	return err == nil && fi.Size() == size
}

// looksUploading reports whether a video file is probably still being
// uploaded: far smaller than its siblings in the same directory.
// ponytail: 50%-of-median heuristic; compression varies between episodes,
// but no episode drops from 1.4GB to 200MB. Needs >= 3 reference files.
func looksUploading(size int64, siblings []int64) bool {
	if len(siblings) < 3 {
		return false
	}
	s := append([]int64(nil), siblings...)
	slices.Sort(s)
	median := s[len(s)/2]
	return size < median/2
}

// Enqueue queues remotePath (file or directory, recursive) below localRel.
// nameFn, when non-nil, maps each remote file name to its local name (watch
// rename templates); existing files with matching size are skipped.
// sizeGuard skips video files that look mid-upload (see looksUploading);
// their count is returned as uploading so the caller can report them.
// The returned ids allow callers to offer an undo/cancel for the batch.
// flat writes a directory's files directly into localRel instead of
// creating a subfolder named after the remote directory (for building
// layouts like Title/Season 01/ from arbitrary remote names).
// langFilter, when non-nil, receives each file's full remote path and must
// return true for the file to be enqueued; false skips it. This lets watches
// sync only files whose name/folder carries a wanted dub/sub language tag.
// filtered counts video files present on the remote but skipped by langFilter
// whose local target does not yet exist - i.e. episodes waiting to appear in
// the wanted dub/sub language.
func (m *Manager) Enqueue(userID, serverID int64, remotePath, localRel string, nameFn func(string) string, langFilter func(string) bool, sizeGuard, flat bool) (ids []int64, uploading, filtered int, err error) {
	if nameFn == nil {
		nameFn = func(s string) string { return s }
	}
	client, _, err := m.Dial(userID, serverID)
	if err != nil {
		return nil, 0, 0, err
	}
	defer client.Close()

	type job struct {
		remote, localRel, dir string
		size                  int64
	}
	var jobs []job
	dirSizes := map[string][]int64{} // per remote dir: sizes of all video files

	entries, listErr := client.List(remotePath)
	// a file: List errors (SFTP) or lists exactly itself (FTP)
	isFile := listErr != nil ||
		(len(entries) == 1 && !entries[0].IsDir && entries[0].Name == path.Base(remotePath))
	if isFile {
		size, serr := client.Size(remotePath)
		if serr != nil {
			return nil, 0, 0, fmt.Errorf("path is neither listable nor a file: %w", serr)
		}
		jobs = append(jobs, job{remotePath, path.Join(localRel, nameFn(path.Base(remotePath))), "", size})
	} else {
		var walk func(dir, rel string, depth int) error
		walk = func(dir, rel string, depth int) error {
			if depth > 16 {
				return fmt.Errorf("directory nesting too deep")
			}
			items, err := client.List(dir)
			if err != nil {
				return err
			}
			for _, e := range items {
				if e.IsDir {
					if err := walk(e.Path, path.Join(rel, e.Name), depth+1); err != nil {
						return err
					}
				} else {
					if VideoExt[strings.ToLower(path.Ext(e.Name))] {
						dirSizes[dir] = append(dirSizes[dir], e.Size)
					}
					jobs = append(jobs, job{e.Path, path.Join(rel, nameFn(e.Name)), dir, e.Size})
				}
			}
			return nil
		}
		base := path.Join(localRel, path.Base(remotePath))
		if flat {
			base = localRel
		}
		if err := walk(remotePath, base, 0); err != nil {
			return nil, 0, 0, err
		}
	}

	for _, j := range jobs {
		local := filepath.Join(m.DownloadRoot, filepath.Clean("/"+j.localRel))
		// language filter: skip files whose name/folder lacks the wanted dub/sub
		// tag; count a video as "waiting" when its target is not yet local (so a
		// version we already have in the right language doesn't inflate the count)
		if langFilter != nil && !langFilter(j.remote) {
			if VideoExt[strings.ToLower(path.Ext(j.remote))] {
				if _, serr := os.Stat(local); serr != nil {
					filtered++
				}
			}
			continue
		}
		// sync: skip files that already exist with the right size
		if fi, err := os.Stat(local); err == nil && fi.Size() == j.size {
			continue
		}
		// probably still being uploaded: wait for a later check
		if sizeGuard && VideoExt[strings.ToLower(path.Ext(j.remote))] && looksUploading(j.size, dirSizes[j.dir]) {
			uploading++
			continue
		}
		// skip duplicates already in the queue
		var existing int
		m.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ? AND remote_path = ?
			AND status IN ('queued','running','paused')`, userID, serverID, j.remote).Scan(&existing)
		if existing > 0 {
			continue
		}
		res, ierr := m.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
			VALUES (?, ?, ?, ?, ?)`, userID, serverID, j.remote, local, j.size)
		if ierr == nil {
			if id, lerr := res.LastInsertId(); lerr == nil {
				ids = append(ids, id)
			}
		}
	}
	m.Wake()
	return ids, uploading, filtered, nil
}

// Shutdown cancels all active downloads, requeues them (resume picks up the
// .part files after restart) and waits for the workers until ctx expires.
func (m *Manager) Shutdown(ctx context.Context) {
	m.mu.Lock()
	m.stopping = true
	for _, r := range m.active {
		r.cancel()
	}
	m.mu.Unlock()
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (m *Manager) Pause(userID, id int64) error {
	m.mu.Lock()
	if r, ok := m.active[id]; ok && r.userID == userID {
		r.paused = true
		r.cancel()
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	return m.setStatusOwned(userID, id, "paused", []string{"queued"})
}

func (m *Manager) Resume(userID, id int64) error {
	if err := m.setStatusOwned(userID, id, "queued", []string{"paused", "error", "canceled"}); err != nil {
		return err
	}
	m.Wake()
	return nil
}

func (m *Manager) Cancel(userID, id int64) error {
	m.mu.Lock()
	if r, ok := m.active[id]; ok && r.userID == userID {
		r.cancel()
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	return m.setStatusOwned(userID, id, "canceled", []string{"queued", "paused", "error"})
}

// SetRateLimit updates a per-download limit (bytes/s, 0 = unlimited), live.
func (m *Manager) SetRateLimit(userID, id, bytesPerSec int64) error {
	res, err := m.DB.Exec(`UPDATE downloads SET rate_limit = ? WHERE id = ? AND user_id = ?`, bytesPerSec, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	m.mu.Lock()
	if r, ok := m.active[id]; ok {
		if bytesPerSec <= 0 {
			r.limiter = nil
		} else if r.limiter == nil {
			r.limiter = newLimiter(bytesPerSec)
		} else {
			r.limiter.SetLimit(rate.Limit(bytesPerSec))
			r.limiter.SetBurst(max(int(bytesPerSec), 32*1024))
		}
	}
	m.mu.Unlock()
	return nil
}

// RunningRates returns the last measured transfer rate per active download.
func (m *Manager) RunningRates() map[int64]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	rates := make(map[int64]int64, len(m.active))
	for id, r := range m.active {
		rates[id] = r.bps
	}
	return rates
}

func (m *Manager) get(id int64) (*Download, error) {
	var d Download
	err := m.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, size, transferred, status, error, rate_limit, created_at
		FROM downloads WHERE id = ?`, id).
		Scan(&d.ID, &d.UserID, &d.ServerID, &d.RemotePath, &d.LocalPath, &d.Size, &d.Transferred, &d.Status, &d.Error, &d.RateLimit, &d.CreatedAt)
	if err != nil {
		return nil, ErrNotFound
	}
	return &d, nil
}

// execRetry runs a write that must not be silently lost. modernc SQLite
// serializes writers, so a concurrent worker/crawler/watch write can transiently
// return "database is locked"; a dropped terminal status update would strand a
// row as running (re-downloaded on the next restart). Retry a few times, then log.
func (m *Manager) execRetry(what, query string, args ...any) {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if _, err = m.DB.Exec(query, args...); err == nil {
			return
		}
		if e := strings.ToLower(err.Error()); !strings.Contains(e, "locked") && !strings.Contains(e, "busy") {
			break // a non-contention error won't clear by retrying
		}
		time.Sleep(time.Duration(attempt+1) * 25 * time.Millisecond)
	}
	slog.Warn("db write failed", "op", what, "err", err)
}

func (m *Manager) setStatus(id int64, status, errMsg string) {
	m.execRetry("setStatus", `UPDATE downloads SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`, status, errMsg, id)
	if d, err := m.get(id); err == nil {
		m.publish(d)
		if m.OnFinished != nil && (status == "done" || status == "error") {
			go m.OnFinished(d)
		}
	}
}

func (m *Manager) setStatusOwned(userID, id int64, status string, from []string) error {
	q := `UPDATE downloads SET status = ?, error = '', updated_at = datetime('now')
		WHERE id = ? AND user_id = ? AND status IN (`
	args := []any{status, id, userID}
	for i, f := range from {
		if i > 0 {
			q += ","
		}
		q += "?"
		args = append(args, f)
	}
	q += ")"
	res, err := m.DB.Exec(q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if d, err := m.get(id); err == nil {
		m.publish(d)
	}
	return nil
}

// ── SSE ─────────────────────────────────────────────────────

func (m *Manager) Subscribe() (<-chan string, func()) {
	ch := make(chan string, 64)
	m.mu.Lock()
	m.subs[ch] = struct{}{}
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		delete(m.subs, ch)
		m.mu.Unlock()
	}
}

func (m *Manager) publish(d *Download) {
	payload, err := json.Marshal(d)
	if err != nil {
		return
	}
	msg := string(payload)
	m.mu.Lock()
	for ch := range m.subs {
		select {
		case ch <- msg:
		default: // slow subscriber: drop rather than block transfers
		}
	}
	m.mu.Unlock()
}
