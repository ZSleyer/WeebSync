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

// dataClient serves data, from any offset, and counts the bytes it hands out.
type dataClient struct {
	data   string
	served *atomic.Int64
}

func (c *dataClient) List(string) ([]remote.Entry, error) { return nil, errors.New("not a dir") }
func (c *dataClient) Size(string) (int64, error)          { return int64(len(c.data)), nil }
func (c *dataClient) Close() error                        { return nil }
func (c *dataClient) Open(_ string, offset int64) (io.ReadCloser, error) {
	c.served.Add(int64(len(c.data)) - offset)
	return io.NopCloser(strings.NewReader(c.data[offset:])), nil
}

func partRun(t *testing.T, part string, transferred int64) (string, int64) {
	t.Helper()
	d := newRetryDB(t)
	root := t.TempDir()
	target := filepath.Join(root, "Show", "ep01.mkv")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".part", []byte(part), 0o644); err != nil {
		t.Fatal(err)
	}
	var served atomic.Int64
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &dataClient{data: "abcdefgh", served: &served}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, transferred)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8, ?)`, target, transferred)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()
	waitFor(t, "the download to end", func() bool {
		s := readRow(t, d, id).status
		return s == "done" || s == "error"
	})
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("no finished file (status %q): %v", readRow(t, d, id).status, err)
	}
	return string(got), served.Load()
}

// A .part file says nothing about where its bytes came from. One left behind
// by another row - a worse variant that gave up at 40 %, a remote file since
// replaced - was taken as this row's progress, and the rest appended to it:
// right size, mixed content, status done. A row resumes only the bytes it
// wrote itself.
func TestForeignPartIsNotResumed(t *testing.T) {
	got, served := partRun(t, "ZZZZ", 0) // nothing written by this row yet
	if got != "abcdefgh" {
		t.Errorf("file %q, want the remote content alone", got)
	}
	if served != 8 {
		t.Errorf("%d bytes fetched, want the whole file", served)
	}
}

// A canceled download leaves nothing behind: its partial file is gigabytes
// nobody will resume, and the next row for that file must not find it.
func TestCancelRemovesPart(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	target := filepath.Join(root, "ep01.mkv")
	gate := make(chan struct{})
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &gateClient{size: 8, gate: gate}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, target)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()
	waitFor(t, "the .part to exist", func() bool {
		_, err := os.Stat(target + ".part")
		return err == nil
	})
	if err := m.Cancel(1, id); err != nil {
		t.Fatal(err)
	}
	close(gate)
	waitFor(t, "the cancel", func() bool { return readRow(t, d, id).status == "canceled" })
	if _, err := os.Stat(target + ".part"); !os.IsNotExist(err) {
		t.Errorf("the .part of a canceled download is still there (err %v)", err)
	}
}

// A row's own progress still resumes, from what the database knows it wrote.
func TestOwnPartResumes(t *testing.T) {
	got, served := partRun(t, "abcdef", 4)
	if got != "abcdefgh" {
		t.Errorf("file %q, want abcdefgh", got)
	}
	if served != 4 {
		t.Errorf("%d bytes fetched, want the 4 after the recorded progress", served)
	}
}
