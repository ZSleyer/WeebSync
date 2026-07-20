package api

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/push"
)

// digestTestServer gives a Server with a real schema and a push service, so
// the flush path runs end to end without sending anything (no subscriptions).
func digestTestServer(t *testing.T) *Server {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	p, err := push.New(d)
	if err != nil {
		t.Fatal(err)
	}
	// downloads reference a user and a server
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1, 1, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`); err != nil {
		t.Fatal(err)
	}
	return &Server{DB: d, Push: p}
}

// insertDownload adds a row in the given status; the digest only ever looks at
// the status column.
func insertDownload(t *testing.T, s *Server, status string) {
	t.Helper()
	if _, err := s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status)
		VALUES (1, 1, '/a.mkv', '/dl', ?)`, status); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadsPendingIgnoresPaused(t *testing.T) {
	s := digestTestServer(t)

	if s.downloadsPending() {
		t.Error("empty queue reported as pending")
	}
	// paused is deliberately not pending - it would hold a digest forever
	insertDownload(t, s, "paused")
	insertDownload(t, s, "done")
	insertDownload(t, s, "error")
	if s.downloadsPending() {
		t.Error("paused/finished downloads reported as pending")
	}
	insertDownload(t, s, "queued")
	if !s.downloadsPending() {
		t.Error("queued download not reported as pending")
	}
}

// A digest must not go out while the queue is still working; it has to wait
// for the queue to run dry.
func TestFlushDigestWaitsForQueue(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, 20*time.Millisecond)()

	insertDownload(t, s, "running")
	s.NotifyDownload(1, "download_done", 1, "/one.mkv", "")

	// several quiet periods pass while the queue is still busy
	time.Sleep(120 * time.Millisecond)
	s.digestMu.Lock()
	held := len(s.digest["1|download_done"])
	s.digestMu.Unlock()
	if held != 1 {
		t.Fatalf("item was flushed while the queue was busy (held %d, want 1)", held)
	}

	// queue runs dry -> the next round flushes
	if _, err := s.DB.Exec(`UPDATE downloads SET status = 'done'`); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, func() bool {
		s.digestMu.Lock()
		defer s.digestMu.Unlock()
		return len(s.digest["1|download_done"]) == 0
	}, "digest was never flushed after the queue drained")
}

// Every new download restarts the quiet period, so a running sync collects
// into one notification instead of several.
func TestNotifyDownloadDebounces(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, 100*time.Millisecond)()

	const key = "1|download_done"
	for i := 0; i < 4; i++ {
		s.NotifyDownload(1, "download_done", 1, "/ep.mkv", "")
		time.Sleep(40 * time.Millisecond) // shorter than the quiet period
	}
	// 160ms elapsed, well past one quiet period, but each item pushed it back
	s.digestMu.Lock()
	held := len(s.digest[key])
	s.digestMu.Unlock()
	if held != 4 {
		t.Fatalf("timer did not restart: held %d items, want 4", held)
	}

	waitFor(t, 2*time.Second, func() bool {
		s.digestMu.Lock()
		defer s.digestMu.Unlock()
		return len(s.digest[key]) == 0
	}, "digest was never flushed once things went quiet")
}

var quietMu sync.Mutex

// swapQuiet shortens the quiet period for a test and returns the restore func.
func swapQuiet(t *testing.T, d time.Duration) func() {
	t.Helper()
	quietMu.Lock()
	old := digestQuiet
	digestQuiet = d
	return func() {
		digestQuiet = old
		quietMu.Unlock()
	}
}

func waitFor(t *testing.T, limit time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(msg)
}
