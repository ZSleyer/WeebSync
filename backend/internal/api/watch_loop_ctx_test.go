package api

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// On shutdown the watch loop stops before the next due watch: no further
// dial, no further check stamped, so Shutdown is not left waiting on a run
// through every watch.
func TestWatchLoopStopsOnCancel(t *testing.T) {
	d := dbtest.Open(t)
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var dials atomic.Int32
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		cancel() // shutdown arrives while the first watch is being checked
		return nil, "", errors.New("dial tcp: connection refused")
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}
	drainJobsAtCleanup(t, s)
	for _, q := range []string{
		`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`,
		`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`,
		`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
			VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`,
		// both on a due retry: each would be checked in this pass
		`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, retry_at) VALUES (1, 1, '/x/A', 'A', 'template', 1)`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, retry_at) VALUES (1, 1, '/x/B', 'B', 'template', 1)`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	s.checkDueWatches(ctx)
	if n := dials.Load(); n != 1 {
		t.Errorf("dialed %d times, want 1: the loop went on after the cancel", n)
	}
	var checked int
	if err := d.QueryRow(`SELECT COUNT(*) FROM watches WHERE check_attempts > 0`).Scan(&checked); err != nil {
		t.Fatal(err)
	}
	if checked != 1 {
		t.Errorf("%d watches checked, want 1", checked)
	}

	// a check that starts after the cancel does nothing at all
	if out := s.runWatch(ctx, 2); out.Error == "" {
		t.Errorf("runWatch after cancel = %+v, want an error", out)
	}
	if n := dials.Load(); n != 1 {
		t.Errorf("runWatch dialed after the cancel (%d dials)", n)
	}
}
