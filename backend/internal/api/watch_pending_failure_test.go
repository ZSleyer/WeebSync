package api

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// The files waiting for the provider cannot be read: the check stops before
// the server, and that failure has to be booked like any other - a result the
// overview shows and a backoff - instead of looking healthy while the loop
// starts the same failing check again on every tick.
func TestWatchPendingReadFailureBacksOff(t *testing.T) {
	d := dbtest.Open(t)
	root := t.TempDir()
	var dials atomic.Int32
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		return nil, "", errors.New("must not dial")
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}
	drainJobsAtCleanup(t, s)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	res, err := d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode)
		VALUES (1, 1, '/x/Show', 'Show', 'template')`)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	if _, err := d.Exec(`ALTER TABLE pending_episodes RENAME TO pending_episodes_gone`); err != nil {
		t.Fatal(err)
	}

	if out := s.runWatch(t.Context(), id); out.Error == "" {
		t.Errorf("runWatch = %+v, want the read error", out)
	}
	var attempts, queued int
	var retryAt int64
	var result string
	read := func() {
		t.Helper()
		if err := d.QueryRow(`SELECT check_attempts, retry_at, last_result, last_queued FROM watches WHERE id = ?`, id).
			Scan(&attempts, &retryAt, &result, &queued); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if attempts != 1 || retryAt <= time.Now().Unix() || result == "" || queued != -1 {
		t.Errorf("after the failed read: attempts %d retry_at %d result %q queued %d, want 1, future, the error, -1",
			attempts, retryAt, result, queued)
	}

	// the loop waits for the backoff instead of running it again at once
	s.checkDueWatches(t.Context())
	read()
	if attempts != 1 {
		t.Errorf("the loop ran the failing check again before its retry: attempts %d", attempts)
	}
	if n := dials.Load(); n != 0 {
		t.Errorf("dialed %d times, want none", n)
	}
}
