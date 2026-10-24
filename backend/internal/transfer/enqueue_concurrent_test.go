package transfer

import (
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// folderClient lists a folder of three files.
type folderClient struct{}

func (folderClient) List(p string) ([]remote.Entry, error) {
	var out []remote.Entry
	for _, n := range []string{"ep01.mkv", "ep02.mkv", "ep03.mkv"} {
		out = append(out, remote.Entry{Name: n, Path: p + "/" + n, Size: 8})
	}
	return out, nil
}
func (folderClient) Open(string, int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (folderClient) Size(string) (int64, error) { return 8, nil }
func (folderClient) Close() error               { return nil }

// A double click on "download folder" sends two requests. Enqueue skips what
// is already queued, but when both requests had looked before either inserted,
// the file was queued twice - two rows for one file, appending into one .part.
// The check and the insert have to be one step.
func TestConcurrentEnqueueQueuesOnce(t *testing.T) {
	d := newRetryDB(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	dial := func(userID, serverID int64) (remote.Client, string, error) { return folderClient{}, "", nil }
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	// hold both requests between their duplicate check and their insert of
	// the first file, the window a double click falls into
	var arrived sync.WaitGroup
	arrived.Add(2)
	var hits atomic.Int32
	m.beforeInsert = func() {
		if hits.Add(1) <= 2 {
			arrived.Done()
			arrived.Wait()
		}
	}

	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.Enqueue(1, 1, "/x/Show", "", nil, nil, false, false, false); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var n, files int
	if err := d.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT local_path) FROM downloads`).Scan(&n, &files); err != nil {
		t.Fatal(err)
	}
	if n != 3 || files != 3 {
		t.Errorf("%d rows for %d files after a double click, want 3 for 3", n, files)
	}
}
