package transfer

import (
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// A pause that lands between the queue reading a row and starting it used to be
// overwritten: the row went paused, then the start set it running anyway and the
// download ran. Only a row that is still queued may start.
func TestPauseWhileStartingSticks(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	var dials atomic.Int32
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8, 'paused')`, filepath.Join(root, "Show", "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	// the row as the queue read it, then the user's pause before the start
	m.beforeStart = func(int64) {
		if err := m.Pause(1, id); err != nil {
			t.Error(err)
		}
	}
	d.Exec(`UPDATE downloads SET status = 'queued' WHERE id = ?`, id)
	m.mu.Lock()
	m.maxConc = 0 // keep the loop out of it: this test starts the row itself
	m.mu.Unlock()
	m.startDownload(id)

	time.Sleep(200 * time.Millisecond)
	if r := readRow(t, d, id); r.status != "paused" {
		t.Errorf("status %q after a pause during the start, want paused", r.status)
	}
	if n := dials.Load(); n != 0 {
		t.Errorf("%d dials for a paused download", n)
	}
}

// Once Shutdown has run, nothing may start: a worker registered after it has
// gone through the active list is never canceled, and its WaitGroup Add races
// the Wait.
func TestNoStartAfterShutdown(t *testing.T) {
	d := newRetryDB(t)
	var dials atomic.Int32
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		return nil, "", errors.New("connection reset by peer")
	}
	m := NewManager(d, dial, t.TempDir())
	m.mu.Lock()
	m.maxConc = 0
	m.mu.Unlock()
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, filepath.Join(t.TempDir(), "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Shutdown(t.Context())

	m.startDownload(id) // a start that passed startPending's check just before
	time.Sleep(200 * time.Millisecond)
	if n := dials.Load(); n != 0 {
		t.Errorf("%d dials after shutdown", n)
	}
	if r := readRow(t, d, id); r.status != "queued" {
		t.Errorf("status %q after shutdown, want queued", r.status)
	}
}
