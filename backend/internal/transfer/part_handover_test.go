package transfer

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// brokenClient serves data but drops the connection after cut bytes.
type brokenClient struct {
	data string
	cut  int
}

func (c *brokenClient) List(string) ([]remote.Entry, error) { return nil, errors.New("not a dir") }
func (c *brokenClient) Size(string) (int64, error)          { return int64(len(c.data)), nil }
func (c *brokenClient) Close() error                        { return nil }
func (c *brokenClient) Open(_ string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(io.MultiReader(strings.NewReader(c.data[offset:c.cut]), errReader{})), nil
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset by peer") }

// The reverse order of the mixed-content case: row A failed with some of its
// bytes recorded, row B for the same file then cut the .part, wrote its own
// bytes and failed too. Retrying A resumed at A's recorded offset - on B's
// bytes. Whichever row writes the .part makes it its own: every other row's
// recorded progress on that file no longer exists.
func TestRetriedRowDoesNotResumeOnAnotherRowsPart(t *testing.T) {
	d := newRetryDB(t)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'b', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	root := t.TempDir()
	target := filepath.Join(root, "ep01.mkv")
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		if serverID == 2 {
			return &brokenClient{data: "bbbbbbbb", cut: 6}, "", nil
		}
		return &dataClient{data: "aaaaaaaa", served: new(atomic.Int64)}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	// A: failed earlier with 4 bytes recorded (its .part since gone)
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, transferred, status, error)
		VALUES (1, 1, '/a/ep01.mkv', ?, 8, 4, 'error', 'connection reset by peer')`, target)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := res.LastInsertId()
	// B: no attempts left, so its failure is final and keeps the .part
	res, err = d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, attempts)
		VALUES (1, 2, '/b/ep01.mkv', ?, 8, 10)`, target)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := res.LastInsertId()
	m.Wake()
	waitFor(t, "B to fail", func() bool { return readRow(t, d, b).status == "error" })
	if part, err := os.ReadFile(target + ".part"); err != nil || string(part) != "bbbbbb" {
		t.Fatalf("B's .part %q (err %v), want bbbbbb", part, err)
	}

	if err := m.Resume(1, a); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "A to finish", func() bool { return readRow(t, d, a).status == "done" })
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "aaaaaaaa" {
		t.Errorf("file %q, want A's content alone", got)
	}
}
