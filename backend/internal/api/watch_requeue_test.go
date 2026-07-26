package api

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// oneFileClient is a remote holding exactly one file, so a watch check has
// exactly one thing to enqueue.
type oneFileClient struct {
	dir, name string
	size      int64
}

func (c *oneFileClient) List(p string) ([]remote.Entry, error) {
	if p != c.dir {
		return nil, errors.New("no such directory")
	}
	return []remote.Entry{{Name: c.name, Path: c.dir + "/" + c.name, Size: c.size}}, nil
}

func (c *oneFileClient) Open(p string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(strings.Repeat("x", int(c.size-offset)))), nil
}

func (c *oneFileClient) Size(p string) (int64, error) { return c.size, nil }
func (c *oneFileClient) Close() error                 { return nil }

// The reported case, end to end: the container has no write permission on the
// target directory, so the download fails, and the next watch check enqueues
// the very same file again. Repeated every interval this filled the queue with
// identical hopeless entries and the log with identical warnings, while the one
// thing that had to change - the directory's permissions - stayed unmentioned.
//
// A watch check must not re-queue a download that failed for a reason no retry
// can fix. Transient failures (a dropped connection, an unclassified error) are
// unaffected and still come back on the next check.
func TestWatchCheckDoesNotRequeueHopelessDownload(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	root := t.TempDir()
	target := filepath.Join(root, "Show")
	if err := os.Mkdir(target, 0o500); err != nil { // r-x: listable, not writable
		t.Fatal(err)
	}
	// give the permission back, or t.TempDir cleanup cannot remove the tree
	t.Cleanup(func() { os.Chmod(target, 0o700) })

	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &oneFileClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}

	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	res, err := d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode)
		VALUES (1, 1, '/x/Show', 'Show', 'template')`)
	if err != nil {
		t.Fatal(err)
	}
	watchID, _ := res.LastInsertId()

	s.runWatch(watchID)
	if n := countDownloads(t, s); n != 1 {
		t.Fatalf("first check queued %d downloads, want 1", n)
	}

	// let the queue run it into the permission failure
	status, code := awaitDownloadEnd(t, s)
	if status != "error" {
		t.Fatalf("download ended as %q, want error", status)
	}
	if code != transfer.ErrCodePermissionDenied {
		t.Fatalf("error_code = %q, want %q", code, transfer.ErrCodePermissionDenied)
	}

	// the next interval comes around and the folder is still unwritable
	s.runWatch(watchID)
	if n := countDownloads(t, s); n != 1 {
		t.Errorf("second check left %d downloads, want 1 - the failure was queued again", n)
	}

	// an explicit retry stays the user's call: it clears the code, so the row
	// is a candidate again - and now that the directory is writable it succeeds
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := s.Transfers.Resume(1, 1); err != nil {
		t.Fatalf("manual retry: %v", err)
	}
	if status, code := awaitDownloadEnd(t, s); status != "done" || code != "" {
		t.Errorf("after a manual retry: status %q, code %q; want done with a cleared code", status, code)
	}
	s.runWatch(watchID)
	if n := countDownloads(t, s); n != 1 {
		t.Errorf("after a manual retry: %d downloads, want the same single row", n)
	}
}

func countDownloads(t *testing.T, s *Server) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// awaitDownloadEnd waits for the queue worker to finish the single download.
func awaitDownloadEnd(t *testing.T, s *Server) (status, code string) {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		s.DB.QueryRow(`SELECT status, error_code FROM downloads ORDER BY id LIMIT 1`).Scan(&status, &code)
		if status == "error" || status == "done" {
			return status, code
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("download never finished (last status %q)", status)
	return "", ""
}
