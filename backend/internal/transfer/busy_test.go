package transfer

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// A server that allows one or two connections serves a long queue one file at
// a time; the others wait for a free connection, and a wait that runs out
// came back as an ordinary failure. Ten of those and the download stood as an
// error although nothing was wrong. Waiting for a connection does not spend an
// attempt: the row goes back into the queue as it was.
func TestServerBusyDoesNotSpendAttempts(t *testing.T) {
	d := newRetryDB(t)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", fmt.Errorf("%w: %w", remote.ErrServerBusy, context.DeadlineExceeded)
	}
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	m.mu.Lock()
	m.maxConc = 0 // the test starts the row itself, once
	m.mu.Unlock()
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, attempts)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8, 9)`, filepath.Join(t.TempDir(), "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.startDownload(id)
	waitFor(t, "the attempt to end", func() bool { return len(m.RunningRates()) == 0 && readRow(t, d, id).status != "running" })
	r := readRow(t, d, id)
	if r.status != "queued" || r.attempts != 9 {
		t.Errorf("status %q attempts %d after a busy server; want queued and still 9", r.status, r.attempts)
	}
}
