package transfer

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
)

// newRetryDB opens a scratch database with one user and one server, the two
// rows every download needs to exist.
func newRetryDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	return d
}

// waitFor polls until cond holds, so a test never depends on how fast the
// queue loop gets around to a row.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type retryRow struct {
	status, errMsg, code string
	attempts             int
	retryAt              int64
}

func readRow(t *testing.T, d *sql.DB, id int64) retryRow {
	t.Helper()
	var r retryRow
	if err := d.QueryRow(`SELECT status, error, error_code, attempts, retry_at FROM downloads WHERE id = ?`, id).
		Scan(&r.status, &r.errMsg, &r.code, &r.attempts, &r.retryAt); err != nil {
		t.Fatal(err)
	}
	return r
}

// A dropped connection is the failure this whole mechanism exists for: it
// classifies to no code, RetryableCode says yes, and the row has to go back
// into the queue behind a backoff instead of ending as an error the user has
// to click. The error text must survive - a countdown without a reason is an
// unexplained pause.
func TestRetryableFailureRequeuesWithBackoff(t *testing.T) {
	d := newRetryDB(t)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("connection reset by peer")
	}
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, filepath.Join(t.TempDir(), "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the first attempt to fail", func() bool { return readRow(t, d, id).attempts == 1 })
	r := readRow(t, d, id)
	if r.status != "queued" {
		t.Errorf("status %q, want queued", r.status)
	}
	if r.errMsg != "connection reset by peer" {
		t.Errorf("error %q, want the original text", r.errMsg)
	}
	if r.code != "" {
		t.Errorf("error_code %q, want empty (unclassified)", r.code)
	}
	if want := time.Now().Unix(); r.retryAt <= want {
		t.Errorf("retry_at %d, want later than %d", r.retryAt, want)
	}
}

// The failures no retry can fix must still end the download. Repeating a
// permission error forever would bury the one thing that has to change - the
// permissions on the target - under identical entries.
func TestNonRetryableFailureStillErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	d := newRetryDB(t)
	root := t.TempDir()
	target := filepath.Join(root, "Show")
	if err := os.Mkdir(target, 0o500); err != nil { // r-x: listable, not writable
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(target, 0o700) })

	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8)`, filepath.Join(target, "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the download to fail", func() bool { return readRow(t, d, id).status == "error" })
	r := readRow(t, d, id)
	if r.code != ErrCodePermissionDenied {
		t.Errorf("error_code %q, want %q", r.code, ErrCodePermissionDenied)
	}
	if r.attempts != 0 {
		t.Errorf("attempts %d, want 0 (never retried)", r.attempts)
	}
}

// The backoff only means something if the queue respects it: a row whose
// retry_at is still in the future must not be picked up, while the one that is
// due starts normally.
func TestStartPendingRespectsRetryAt(t *testing.T) {
	d := newRetryDB(t)
	dialed := make(chan int64, 4)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dialed <- serverID
		return nil, "", errors.New("connection reset by peer")
	}
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	ins := func(name string, retryAt int64) int64 {
		t.Helper()
		res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, retry_at)
			VALUES (1, 1, ?, ?, 8, ?)`, "/x/"+name, filepath.Join(t.TempDir(), name), retryAt)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	waiting := ins("waiting.mkv", time.Now().Add(time.Hour).Unix())
	due := ins("due.mkv", time.Now().Add(-time.Hour).Unix())
	m.Wake()

	waitFor(t, "the due row to be attempted", func() bool { return readRow(t, d, due).attempts == 1 })
	// the queue loop ticks every two seconds; give it more than one turn
	// before concluding the waiting row was left alone
	time.Sleep(3 * time.Second)
	if r := readRow(t, d, waiting); r.attempts != 0 || r.status != "queued" {
		t.Errorf("waiting row: status %q attempts %d, want queued/0", r.status, r.attempts)
	}
}

// Pressing Retry means "now, and start counting fresh" - otherwise the click
// lands behind the very backoff it was pressed to skip. The row here is the
// state the history's Retry button acts on: a download that ran out of
// attempts the user wants tried again.
func TestResumeClearsRetryState(t *testing.T) {
	d := newRetryDB(t)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("connection reset by peer")
	}
	// max_concurrent 0 keeps the queue loop from starting anything, so the row
	// stays exactly as Resume left it
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, error, attempts, retry_at)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8, 'error', 'connection reset by peer', 3, ?)`,
		filepath.Join(t.TempDir(), "ep01.mkv"), time.Now().Add(time.Hour).Unix())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()

	if err := m.Resume(1, id); err != nil {
		t.Fatal(err)
	}
	r := readRow(t, d, id)
	if r.attempts != 0 || r.retryAt != 0 {
		t.Errorf("attempts %d retry_at %d, want 0/0", r.attempts, r.retryAt)
	}
	if r.errMsg != "" {
		t.Errorf("error %q, want cleared", r.errMsg)
	}
}

func TestBackoffForHoldsAtTheLastRung(t *testing.T) {
	last := retryBackoff[len(retryBackoff)-1]
	for _, tc := range []struct {
		attempts int
		want     time.Duration
	}{
		{0, retryBackoff[0]},
		{1, retryBackoff[0]},
		{2, retryBackoff[1]},
		{len(retryBackoff), last},
		{len(retryBackoff) + 50, last},
	} {
		if got := backoffFor(tc.attempts); got != tc.want {
			t.Errorf("backoffFor(%d) = %v, want %v", tc.attempts, got, tc.want)
		}
	}
}
