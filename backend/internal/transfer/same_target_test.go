package transfer

import (
	"errors"
	"io"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// gateClient serves size bytes, but its reader blocks until gate closes, so a
// download stays running for as long as a test needs.
type gateClient struct {
	size int64
	gate chan struct{}
}

func (c *gateClient) List(string) ([]remote.Entry, error) { return nil, errors.New("not a dir") }
func (c *gateClient) Size(string) (int64, error)          { return c.size, nil }
func (c *gateClient) Close() error                        { return nil }
func (c *gateClient) Open(_ string, offset int64) (io.ReadCloser, error) {
	return io.NopCloser(&gatedReader{gate: c.gate, r: strings.NewReader(strings.Repeat("x", int(c.size-offset)))}), nil
}

type gatedReader struct {
	gate chan struct{}
	r    io.Reader
}

func (g *gatedReader) Read(p []byte) (int, error) {
	<-g.gate
	return g.r.Read(p)
}

// Two rows for one target append into one .part: the bytes interleave and the
// file that ends up "done" is garbage. Enqueue keeps a second row out, but
// retrying an old failed row brought one back - the retry has to be refused
// while another row for the same file is queued, running or paused.
func TestResumeRefusesSecondRowForSameTarget(t *testing.T) {
	d := newRetryDB(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	m := NewManager(d, nil, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	target := filepath.Join(t.TempDir(), "ep01.mkv")
	ins := func(remotePath, status string) int64 {
		res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status)
			VALUES (1, 1, ?, ?, 8, ?)`, remotePath, target, status)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	old := ins("/x/a/ep01.mkv", "error")
	ins("/x/b/ep01.mkv", "queued")

	if err := m.Resume(1, old); !errors.Is(err, ErrTargetBusy) {
		t.Errorf("Resume of a second row for a busy target: %v, want ErrTargetBusy", err)
	}
	if r := readRow(t, d, old); r.status != "error" {
		t.Errorf("status %q, want error", r.status)
	}
	if err := m.Resume(1, 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("Resume of an unknown row: %v, want ErrNotFound", err)
	}
}

// Whatever let two such rows into the queue, the scheduler must not run them
// side by side.
func TestSchedulerRunsOneRowPerTarget(t *testing.T) {
	d := newRetryDB(t)
	gate := make(chan struct{})
	var dials atomic.Int32
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		return &gateClient{size: 8, gate: gate}, "", nil
	}
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	m.mu.Lock()
	m.maxConc = 0 // the test starts the rows itself
	m.mu.Unlock()
	target := filepath.Join(m.DownloadRoot, "ep01.mkv")
	var ids []int64
	for _, p := range []string{"/x/a/ep01.mkv", "/x/b/ep01.mkv"} {
		res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
			VALUES (1, 1, ?, ?, 8)`, p, target)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		ids = append(ids, id)
	}
	m.startDownload(ids[0])
	m.startDownload(ids[1])
	time.Sleep(200 * time.Millisecond)
	if n := len(m.RunningRates()); n != 1 {
		t.Errorf("%d downloads running for one target, want 1", n)
	}
	if r := readRow(t, d, ids[1]); r.status != "queued" {
		t.Errorf("second row %q, want it left queued", r.status)
	}
	close(gate)
	waitFor(t, "the first row to finish", func() bool { return readRow(t, d, ids[0]).status == "done" })
}
