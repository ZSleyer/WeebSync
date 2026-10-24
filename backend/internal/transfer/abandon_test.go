package transfer

import (
	"errors"
	"io"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// stuckClient's reads never return until it is aborted - an SFTP server that
// hangs behind an SSH transport kept alive by keepalives, which no idle
// deadline catches.
type stuckClient struct {
	once    sync.Once
	aborted chan struct{}
	closed  atomic.Bool
}

func (c *stuckClient) List(string) ([]remote.Entry, error) { return nil, errors.New("not a dir") }
func (c *stuckClient) Size(string) (int64, error)          { return 8, nil }
func (c *stuckClient) Close() error {
	<-c.aborted // like pkg/sftp: Close waits for the stuck request
	c.closed.Store(true)
	return nil
}
func (c *stuckClient) Abort() { c.once.Do(func() { close(c.aborted) }) }
func (c *stuckClient) Open(string, int64) (io.ReadCloser, error) {
	return io.NopCloser(stuckRead{c.aborted}), nil
}

type stuckRead struct{ aborted chan struct{} }

func (r stuckRead) Read([]byte) (int, error) {
	<-r.aborted
	return 0, errors.New("connection aborted")
}

// A call left behind by a cancel used to keep its connection until it
// returned - never, for a stuck SFTP server - and with it a pool slot, so a
// server allowing one connection went silently dead for every later download.
// After a grace period the abandoned call's client is aborted and released.
func TestAbandonedCallIsAbortedAfterGrace(t *testing.T) {
	old := abandonGrace
	abandonGrace = 100 * time.Millisecond
	t.Cleanup(func() { abandonGrace = old })

	d := newRetryDB(t)
	c := &stuckClient{aborted: make(chan struct{})}
	dial := func(userID, serverID int64) (remote.Client, string, error) { return c, "", nil }
	root := t.TempDir()
	m := NewManager(d, dial, root)
	t.Cleanup(func() { c.Abort(); m.Shutdown(t.Context()) })
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, filepath.Join(root, "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()
	waitFor(t, "the download to run", func() bool { return readRow(t, d, id).status == "running" })
	time.Sleep(50 * time.Millisecond) // into the stuck read
	if err := m.Cancel(1, id); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the cancel", func() bool { return readRow(t, d, id).status == "canceled" })
	waitFor(t, "the stuck client to be aborted and closed", func() bool { return c.closed.Load() })
}
