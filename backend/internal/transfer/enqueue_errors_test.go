package transfer

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
)

// globClient answers like vsftpd for a file named with glob characters: LIST
// is an empty success, SIZE knows the file. Any other path has no size.
type globClient struct {
	file string
	size int64
}

func (c *globClient) List(p string) ([]remote.Entry, error) { return nil, nil }
func (c *globClient) Open(p string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (c *globClient) Size(p string) (int64, error) {
	if p != c.file {
		return 0, errors.New("550 not a plain file")
	}
	return c.size, nil
}
func (c *globClient) Close() error { return nil }

func enqueueManager(t *testing.T) *Manager {
	t.Helper()
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	return NewManager(d, nil, t.TempDir())
}

// A single-file download of "x [1080p].mkv" lists as nothing on vsftpd; that
// is a file (SIZE answers), not an empty directory with nothing to queue.
func TestEnqueueFileWhoseListingIsEmpty(t *testing.T) {
	m := enqueueManager(t)
	const file = "/x/Show E01 [1080p].mkv"
	m.Dial = func(userID, serverID int64) (remote.Client, string, error) {
		return &globClient{file: file, size: 100}, "", nil
	}
	res, err := m.Enqueue(1, 1, file, "Show", nil, nil, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 1 {
		t.Fatalf("queued %d, want the file", len(res.IDs))
	}
	// a real empty directory has no SIZE: still nothing to do, no error
	res, err = m.Enqueue(1, 1, "/x/empty", "Show", nil, nil, false, true, false)
	if err != nil || len(res.IDs) != 0 {
		t.Fatalf("empty dir: %d queued, err %v", len(res.IDs), err)
	}
}

// Only a regular file at the target is "already there": a directory of the
// same size is in the way, not the episode.
func TestEnqueueDirectoryAtTargetIsNotPresent(t *testing.T) {
	m := enqueueManager(t)
	target := filepath.Join(m.DownloadRoot, "Show", "E01.mkv")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	m.Dial = func(userID, serverID int64) (remote.Client, string, error) {
		return &multiClient{dir: "/x/Show", entries: []remote.Entry{
			{Name: "E01.mkv", Path: "/x/Show/E01.mkv", Size: fi.Size()},
		}}, "", nil
	}
	res, err := m.Enqueue(1, 1, "/x/Show", "Show", nil, nil, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != 0 || len(res.IDs) != 1 {
		t.Fatalf("skipped %d, queued %d; a directory is no present file", res.Skipped, len(res.IDs))
	}
}

// A failing database queues nothing, and says so.
func TestEnqueueReturnsDatabaseErrors(t *testing.T) {
	m := enqueueManager(t)
	m.Dial = func(userID, serverID int64) (remote.Client, string, error) {
		return &multiClient{dir: "/x/Show", entries: []remote.Entry{
			{Name: "E01.mkv", Path: "/x/Show/E01.mkv", Size: 10},
		}}, "", nil
	}
	if _, err := m.DB.Exec(`DROP TABLE downloads`); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Enqueue(1, 1, "/x/Show", "Show", nil, nil, false, true, false); err == nil {
		t.Fatal("a failing duplicate lookup was swallowed")
	}
}
