package transfer

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
)

type stubClient struct {
	dir, name string
	size      int64
}

func (c *stubClient) List(p string) ([]remote.Entry, error) {
	if p != c.dir {
		return nil, errors.New("no such directory")
	}
	return []remote.Entry{{Name: c.name, Path: c.dir + "/" + c.name, Size: c.size}}, nil
}

func (c *stubClient) Open(p string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(strings.Repeat("x", int(c.size-offset)))), nil
}

func (c *stubClient) Size(p string) (int64, error) { return c.size, nil }
func (c *stubClient) Close() error                 { return nil }

// Enqueue must treat a download that failed for a still-standing, non-retryable
// reason as already handled: queuing the same remote file again reproduces the
// identical failure and buries the real problem under duplicate rows. Two exits
// from that state, and both have to work: the user retries the download by hand
// (the code is cleared), or the user fixes the cause (the target accepts writes
// again) and the next check picks the file up on its own.
func TestEnqueueSkipsNonRetryableFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	// keep the queue loop from starting anything while we count rows
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)

	root := t.TempDir()
	target := filepath.Join(root, "Show")
	if err := os.Mkdir(target, 0o500); err != nil { // r-x: listable, not writable
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(target, 0o700) }) // or the temp tree cannot be removed

	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)

	// the failure the container produced on an unwritable media directory
	d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, error, error_code)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8, 'error',
		        'open ep01.mkv.part: permission denied', ?)`,
		filepath.Join(target, "ep01.mkv"), ErrCodePermissionDenied)

	rows := func() int {
		t.Helper()
		var n int
		d.QueryRow(`SELECT COUNT(*) FROM downloads WHERE remote_path = '/x/Show/ep01.mkv'`).Scan(&n)
		return n
	}
	check := func() {
		t.Helper()
		if _, err := m.Enqueue(1, 1, "/x/Show", "Show", nil, nil, true, true); err != nil {
			t.Fatal(err)
		}
	}

	// two more checks while the directory stays unwritable: no second row
	for i := range 2 {
		check()
		if n := rows(); n != 1 {
			t.Fatalf("check %d: %d rows, want 1", i+1, n)
		}
	}

	// the user retries by hand: the code is cleared, so the file is a candidate
	// again even though nothing about the directory changed
	d.Exec(`UPDATE downloads SET error_code = '' WHERE remote_path = '/x/Show/ep01.mkv'`)
	check()
	if n := rows(); n != 2 {
		t.Errorf("after clearing the code: %d rows, want 2", n)
	}

	// the other exit: the user fixes the permissions and the next check queues
	// the file again on its own, without touching any download by hand
	d.Exec(`UPDATE downloads SET status = 'error', error_code = ? WHERE remote_path = '/x/Show/ep01.mkv'`, ErrCodePermissionDenied)
	d.Exec(`DELETE FROM downloads WHERE id = 2`)
	check()
	if n := rows(); n != 1 {
		t.Fatalf("still unwritable: %d rows, want 1", n)
	}
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
	check()
	if n := rows(); n != 2 {
		t.Errorf("after fixing the permissions: %d rows, want 2", n)
	}
}

// multiClient lists a fixed set of files in one directory.
type multiClient struct {
	dir     string
	entries []remote.Entry
}

func (c *multiClient) List(p string) ([]remote.Entry, error) {
	if p != c.dir {
		return nil, errors.New("no such directory")
	}
	return c.entries, nil
}

func (c *multiClient) Open(p string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (c *multiClient) Size(p string) (int64, error) { return 0, nil }
func (c *multiClient) Close() error                 { return nil }

// Two releases of one episode rename to the same local file. Only the better
// one may be fetched: queuing both made every check find the target holding the
// other variant's size, so a watch re-downloaded the episode every interval and
// the file on disk was whichever release had been checked last.
func TestEnqueuePicksBestVariantPerTarget(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)

	const (
		jap = "Youjo Senki II E01 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv"
		ger = "Youjo Senki II E01 [1080p][AAC][GerJapDub][GerEngSub][Web-DL].mkv"
	)
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "Show"), 0o700); err != nil {
		t.Fatal(err)
	}
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &multiClient{dir: "/x/Show", entries: []remote.Entry{
			{Name: jap, Path: "/x/Show/" + jap, Size: 100},
			{Name: ger, Path: "/x/Show/" + ger, Size: 200},
		}}, "", nil
	}
	m := NewManager(d, dial, root)
	// the watch's rename rule: both releases become the same episode file
	nameFn := func(string) string { return "Tanya - S02E01.mkv" }
	target := filepath.Join(root, "Show", "Tanya - S02E01.mkv")

	res, err := m.Enqueue(1, 1, "/x/Show", "Show", nameFn, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 1 {
		t.Fatalf("queued %d files, want 1", len(res.IDs))
	}
	var queued string
	d.QueryRow(`SELECT remote_path FROM downloads WHERE id = ?`, res.IDs[0]).Scan(&queued)
	if queued != "/x/Show/"+ger {
		t.Errorf("queued %q, want the GerJapDub release", queued)
	}

	// that download lands: the next check must leave it alone instead of
	// replacing it with the other variant
	d.Exec(`UPDATE downloads SET status = 'done'`)
	if err := os.WriteFile(target, make([]byte, 200), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = m.Enqueue(1, 1, "/x/Show", "Show", nameFn, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 0 {
		t.Fatalf("re-queued %d files, want 0", len(res.IDs))
	}

	// the weaker release is on disk (it was there first): the better one
	// replaces it, once
	if err := os.WriteFile(target, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = m.Enqueue(1, 1, "/x/Show", "Show", nameFn, nil, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 1 {
		t.Fatalf("queued %d files for the upgrade, want 1", len(res.IDs))
	}
	d.QueryRow(`SELECT remote_path FROM downloads WHERE id = ?`, res.IDs[0]).Scan(&queued)
	if queued != "/x/Show/"+ger {
		t.Errorf("upgrade queued %q, want the GerJapDub release", queued)
	}
}
