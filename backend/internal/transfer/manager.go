// Package transfer runs the download queue: worker pool, throttling,
// resume, sync and SSE progress events.
package transfer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/rename"
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
	// ErrorCode classifies Error into a stable machine-readable reason
	// (see classifyError); empty when the failure is not one we recognize.
	ErrorCode   string `json:"errorCode,omitempty"`
	RateLimit   int64  `json:"rateLimit"`
	BytesPerSec int64  `json:"bytesPerSec,omitempty"`
	// Attempts counts the failures behind this row so far, RetryAt (unix
	// seconds) says when the next attempt may start. A row waiting for its
	// next attempt stays queued and keeps Error/ErrorCode, so the UI can say
	// what went wrong and how long the wait is.
	Attempts int   `json:"attempts,omitempty"`
	RetryAt  int64 `json:"retryAt,omitempty"`
	// ReplaceOld: once this file is in place, the older copy of the same
	// episode next to it is moved out of the way (an upgrade sync).
	ReplaceOld bool   `json:"replaceOld,omitempty"`
	CreatedAt  string `json:"createdAt"`
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
	// Roots is the allowlist of local roots a target path may live under
	// (arbitrary media mounts). Empty falls back to [DownloadRoot].
	Roots []string
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

// ResolveLocal maps a target path to an absolute path under one of the allowed
// roots. An absolute path is accepted when it is under any root; anything else
// is treated as legacy/relative and resolved under the first (primary) root.
// This keeps arbitrary media mounts reachable without exposing the whole
// filesystem, and stays backward-compatible with root-relative watch targets.
func ResolveLocal(roots []string, p string) (string, error) {
	if len(roots) == 0 {
		return "", errors.New("no local roots configured")
	}
	clean := filepath.Clean("/" + strings.TrimPrefix(p, "/"))
	for _, root := range roots {
		r := filepath.Clean(root)
		if clean == r || strings.HasPrefix(clean, r+string(filepath.Separator)) {
			return clean, nil
		}
	}
	primary := filepath.Clean(roots[0])
	abs := filepath.Join(primary, clean)
	if abs == primary || strings.HasPrefix(abs, primary+string(filepath.Separator)) {
		return abs, nil
	}
	return "", errors.New("path outside allowed roots")
}

func (m *Manager) roots() []string {
	if len(m.Roots) > 0 {
		return m.Roots
	}
	return []string{m.DownloadRoot}
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

// clampInt narrows an int64 setting to a non-negative int without wrapping on
// 32-bit builds. ponytail: MaxInt32 ceiling is far above any real concurrency/rate value.
func clampInt(v int64) int {
	const maxInt32 = 1<<31 - 1
	if v < 0 {
		return 0
	}
	if v > maxInt32 {
		return maxInt32
	}
	return int(v)
}

func (m *Manager) reloadSettings() {
	conc := m.setting("max_concurrent", 3)
	limit := m.setting("global_rate_limit", 0)
	m.mu.Lock()
	m.maxConc = clampInt(conc)
	if limit <= 0 {
		m.global = nil
	} else if m.global == nil {
		m.global = newLimiter(limit)
	} else {
		m.global.SetLimit(rate.Limit(limit))
		m.global.SetBurst(max(clampInt(limit), 32*1024))
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
	// retry_at gates a row that failed and is waiting out its backoff. The
	// clock comes from Go rather than SQLite's strftime: one source of "now"
	// for the queue and the tests, and no column-affinity surprises.
	rows, err := m.DB.Query(`SELECT id FROM downloads WHERE status = 'queued' AND retry_at <= ? ORDER BY id LIMIT ?`,
		time.Now().Unix(), free)
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

	m.setStatus(id, "running", "", "")
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
			m.setStatus(id, "done", "", "")
		case paused:
			m.setStatus(id, "paused", "", "")
		case stopping && ctx.Err() != nil:
			// graceful shutdown: back to the queue, resumes from .part on restart
			m.setStatus(id, "queued", "", "")
		case ctx.Err() != nil:
			m.setStatus(id, "canceled", "", "")
		default:
			code := classifyError(err)
			// a failure that clears up by itself (dropped connection, short
			// read) goes back into the queue behind a backoff instead of
			// ending the download; resume picks the .part file back up
			if RetryableCode(code) && m.retryLater(id, err, code) {
				break
			}
			slog.Warn("download failed", "id", id, "code", code, "err", err)
			m.setStatus(id, "error", err.Error(), code)
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
		// self-heal skip: file already present at full size (stale queue)
		slog.Debug("download skipped", "id", d.ID, "reason", "already complete", "size", size)
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
	slog.Info("download complete", "id", d.ID, "size", size)
	return os.Rename(part, d.LocalPath)
}

// ── public API used by handlers ─────────────────────────────

var ErrNotFound = fmt.Errorf("download not found")

// VideoExt lists file extensions treated as episodes (upload guard,
// completeness checks).
var VideoExt = map[string]bool{".mkv": true, ".mp4": true, ".avi": true, ".ts": true, ".m2ts": true, ".webm": true, ".mov": true}

// SubExt lists file extensions treated as a subtitle sitting beside a video.
// Such a file is a real, selectable subtitle track - the thing a release with
// burned-in subtitles cannot offer - so the quality scan counts it.
//
// ".idx" is deliberately absent: it is only the index half of a VobSub pair and
// names no language the ".sub" beside it does not.
var SubExt = map[string]bool{".ass": true, ".ssa": true, ".srt": true, ".sub": true, ".vtt": true}

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
// replaceOld marks every queued row so that, once its file is in place, the
// older copy of the same episode beside it is moved out of the way.
// EnqueueResult says what became of the files a sync looked at. The counters
// are the difference between "nothing to do" and "something went wrong", which
// a bare list of queued ids cannot express: a caller that only reports len(IDs)
// tells the user "0 queued" and leaves them guessing.
type EnqueueResult struct {
	IDs       []int64
	Uploading int // still growing on the remote, so not fetched yet
	Filtered  int // skipped by the language filter
	Skipped   int // already present at the target, same size
}

func (m *Manager) Enqueue(userID, serverID int64, remotePath, localRel string, nameFn func(string) string, langFilter func(string) bool, sizeGuard, flat, replaceOld bool) (res EnqueueResult, err error) {
	if nameFn == nil {
		nameFn = func(s string) string { return s }
	}
	client, _, err := m.Dial(userID, serverID)
	if err != nil {
		return res, err
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
			return res, fmt.Errorf("path is neither listable nor a file: %w", serr)
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
			return res, err
		}
	}

	// one writability probe per target directory, shared by every file in it
	probed := map[string]string{}

	// Two releases of the same episode - a JapDub and the GerJapDub that follows
	// days later - rename to the SAME local file. Fetching both is what made a
	// watch re-download an episode on every check: whichever variant sat at the
	// target, the other one was missing by size, so the two took turns
	// overwriting each other every interval, forever. Only the best variant per
	// target stays a candidate, so what ends up on disk is the better release
	// rather than the one checked last.
	best := map[string]*job{}
	var targets []string
	for _, j := range jobs {
		local, lerr := ResolveLocal(m.roots(), j.localRel)
		if lerr != nil {
			continue // target outside the allowed roots: skip this file
		}
		// language filter: skip files whose name/folder lacks the wanted dub/sub
		// tag; count a video as "waiting" when its target is not yet local (so a
		// version we already have in the right language doesn't inflate the count)
		if langFilter != nil && !langFilter(j.remote) {
			if VideoExt[strings.ToLower(path.Ext(j.remote))] {
				if _, serr := os.Stat(local); serr != nil {
					res.Filtered++
				}
			}
			continue
		}
		cur, seen := best[local]
		if !seen {
			jc := j
			best[local] = &jc
			targets = append(targets, local)
			continue
		}
		win, lose := j, *cur
		if !betterVariant(path.Base(j.remote), j.size, path.Base(cur.remote), cur.size) {
			win, lose = lose, j
		}
		*cur = win
		slog.Debug("variant dropped", "reason", "another release renames to the same file",
			"kept", logSafe(path.Base(win.remote)), "dropped", logSafe(path.Base(lose.remote)))
	}

	for _, local := range targets {
		j := *best[local]
		// sync: skip files that already exist with the right size. Counted, so
		// the caller can say "already there" instead of a bare "0 queued"
		if fi, err := os.Stat(local); err == nil && fi.Size() == j.size {
			res.Skipped++
			continue
		}
		// probably still being uploaded: wait for a later check
		if sizeGuard && VideoExt[strings.ToLower(path.Ext(j.remote))] && looksUploading(j.size, dirSizes[j.dir]) {
			res.Uploading++
			continue
		}
		// skip duplicates already in the queue. A row waiting out a retry
		// backoff is queued, so a watch check that comes around while a
		// download is between attempts adds nothing - the existing row keeps
		// its .part file and its attempt count.
		var existing int
		m.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ? AND remote_path = ?
			AND status IN ('queued','running','paused')`, userID, serverID, j.remote).Scan(&existing)
		if existing > 0 {
			continue
		}
		// skip a file whose last attempt failed for a reason that still holds. A
		// watch checks every interval, so an unwritable target used to be queued
		// again and again: the queue and the log filled with identical hopeless
		// entries, while the one thing that had to change - the permissions on
		// the target - was never said out loud. The probe is what lifts the
		// block: the moment the directory accepts a write the file becomes a
		// candidate again, without the user retrying every download by hand.
		if m.blocked(userID, serverID, j.remote, filepath.Dir(local), probed) {
			continue
		}
		ins, ierr := m.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, replace_old)
			VALUES (?, ?, ?, ?, ?, ?)`, userID, serverID, j.remote, local, j.size, replaceOld)
		if ierr == nil {
			if id, lerr := ins.LastInsertId(); lerr == nil {
				res.IDs = append(res.IDs, id)
			}
		}
	}
	m.Wake()
	return res, nil
}

// betterVariant reports whether one release wins over another as the source for
// the local file both of them rename to: higher resolution first, then the more
// complete dub, then the more complete sub, and a larger file as the last word.
//
// Both sides are judged by their names alone. That is weaker evidence than the
// measured tracks the upgrade suggestions compare, and deliberately so: this
// decision has to be made for every file of every check, before anything is
// downloaded, and it only has to order two releases of one episode against each
// other - not to state what either of them really carries. A tie leaves the
// first one found in place, so a check that changes nothing keeps its answer.
func betterVariant(name string, size int64, thanName string, thanSize int64) bool {
	if a, b := rename.Resolution(name), rename.Resolution(thanName); a != b {
		return a > b
	}
	dub, sub := rename.LangTags(name)
	thanDub, thanSub := rename.LangTags(thanName)
	if a, b := len(rename.Codes(dub)), len(rename.Codes(thanDub)); a != b {
		return a > b
	}
	if a, b := len(rename.Codes(sub)), len(rename.Codes(thanSub)); a != b {
		return a > b
	}
	return size > thanSize
}

// logSafe strips CR/LF so a remote file name cannot forge log lines.
func logSafe(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

// blocked reports whether the last attempt at remotePath failed for a reason no
// retry can fix and that reason still holds. probed caches the per-directory
// answer for the duration of one Enqueue, so a season folder costs one probe.
func (m *Manager) blocked(userID, serverID int64, remotePath, dir string, probed map[string]string) bool {
	var code string
	m.DB.QueryRow(`SELECT error_code FROM downloads
		WHERE user_id = ? AND server_id = ? AND remote_path = ? AND status = 'error'
		ORDER BY id DESC LIMIT 1`, userID, serverID, remotePath).Scan(&code)
	if RetryableCode(code) {
		return false
	}
	still, ok := probed[dir]
	if !ok {
		still, _ = CheckWritable(dir)
		probed[dir] = still
	}
	return still != ""
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
	err := m.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, size, transferred, status, error, error_code, rate_limit, attempts, retry_at, replace_old, created_at
		FROM downloads WHERE id = ?`, id).
		Scan(&d.ID, &d.UserID, &d.ServerID, &d.RemotePath, &d.LocalPath, &d.Size, &d.Transferred, &d.Status, &d.Error, &d.ErrorCode, &d.RateLimit, &d.Attempts, &d.RetryAt, &d.ReplaceOld, &d.CreatedAt)
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

// Error codes stored in downloads.error_code. They name a cause the user can
// act on; anything else stays empty and only carries its raw text.
const (
	ErrCodePermissionDenied = "permission_denied" // no write permission on the target
	ErrCodeDiskFull         = "disk_full"         // no space left on the target device
	ErrCodeReadOnly         = "read_only"         // target mounted read-only
)

// classifyError maps a transfer failure onto one of the error codes above.
//
// Matching goes exclusively through errors.Is: the message text of an
// *fs.PathError is produced by the kernel and the Go runtime, differs between
// platforms and wrappers, and would silently stop matching the day either
// rewords it. errors.Is walks the wrap chain instead, so a target wrapped in
// several layers still classifies.
//
// An unrecognized error yields "": the raw text is all we know, and inventing
// a code for it would make the UI explain a cause it cannot know.
func classifyError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, fs.ErrPermission):
		return ErrCodePermissionDenied
	case errors.Is(err, syscall.ENOSPC):
		return ErrCodeDiskFull
	case errors.Is(err, syscall.EROFS):
		return ErrCodeReadOnly
	}
	return ""
}

// RetryableCode reports whether a failure with this error code is worth queuing
// again on its own. Permission, space and read-only failures are not: they last
// until a human changes something on the host, and repeating them only buries
// the real problem under identical entries. An unclassified failure (a dropped
// connection, a short read) is retryable - those clear up by themselves.
func RetryableCode(code string) bool {
	return !slices.Contains([]string{ErrCodePermissionDenied, ErrCodeDiskFull, ErrCodeReadOnly}, code)
}

// CheckWritable reports whether a file can be created in dir, as the classified
// reason why not ("" when it can). It writes and removes a probe file rather
// than reading the mode bits: an ACL, a read-only mount or a full device all
// deny a write the bits appear to allow, and those are exactly the failures
// worth naming. A missing directory is created, which is what the first
// transfer into it would do anyway.
func CheckWritable(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return classifyError(err), err
	}
	f, err := os.CreateTemp(dir, ".weebsync-probe-*")
	if err != nil {
		return classifyError(err), err
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return "", nil
}

// Retry pacing: the wait doubles with every failed attempt and holds at
// retryCap, and after retryLimit attempts the download gives up for good.
//
// Doubling is what makes one policy fit two very different failures: a blip
// is over before the third attempt, while a server that is down for an hour
// is asked once every five minutes instead of once a second. The limit is
// what keeps the queue honest - a remote file that was deleted classifies as
// transient (there is no code for "gone"), and without a ceiling it would be
// fetched forever.
const (
	retryLimit = 10
	retryBase  = 5 * time.Second
	retryCap   = 5 * time.Minute
)

// backoffFor is the wait before attempt number attempts+1: retryBase doubled
// once per attempt so far, never longer than retryCap.
func backoffFor(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 20 {
		return retryCap // beyond this the shift below would overflow
	}
	if d := retryBase << (attempts - 1); d < retryCap {
		return d
	}
	return retryCap
}

// retryLater puts a failed download back into the queue behind a backoff and
// reports whether it did. It declines once the attempts run out, leaving the
// caller to end the download the ordinary way.
//
// It deliberately does not go through setStatus: that clears error and
// error_code, and a row waiting for its next attempt has to keep saying what
// went wrong - a countdown without a reason is just an unexplained pause.
func (m *Manager) retryLater(id int64, cause error, code string) bool {
	d, err := m.get(id)
	if err != nil || d.Attempts >= retryLimit {
		return false
	}
	attempts := d.Attempts + 1
	wait := backoffFor(attempts)
	retryAt := time.Now().Add(wait).Unix()
	m.execRetry("retryLater", `UPDATE downloads SET status = 'queued', attempts = ?, retry_at = ?,
		error = ?, error_code = ?, updated_at = datetime('now') WHERE id = ?`,
		attempts, retryAt, cause.Error(), code, id)
	slog.Info("download retry scheduled", "id", id, "attempt", attempts, "of", retryLimit, "in", wait, "err", cause)
	d.Status, d.Attempts, d.RetryAt, d.Error, d.ErrorCode = "queued", attempts, retryAt, cause.Error(), code
	m.publish(d)
	return true
}

func (m *Manager) setStatus(id int64, status, errMsg, errCode string) {
	m.execRetry("setStatus", `UPDATE downloads SET status = ?, error = ?, error_code = ?, updated_at = datetime('now') WHERE id = ?`, status, errMsg, errCode, id)
	if d, err := m.get(id); err == nil {
		m.publish(d)
		if m.OnFinished != nil && (status == "done" || status == "error") {
			go m.OnFinished(d)
		}
	}
}

func (m *Manager) setStatusOwned(userID, id int64, status string, from []string) error {
	// attempts/retry_at reset with the status: a user acting on a row means
	// "now, and start counting fresh". Without it a hand-pressed Retry would
	// sit behind the backoff it was pressed to skip. Pause and cancel clear
	// them too - the count is meaningless for a row nobody is retrying.
	q := `UPDATE downloads SET status = ?, error = '', error_code = '', attempts = 0, retry_at = 0, updated_at = datetime('now')
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
