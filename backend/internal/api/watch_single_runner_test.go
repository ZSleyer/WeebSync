package api

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// meetingClient lists one file, but waits a while in List for a second lister
// of the same folder: two checks of one watch at once would both be inside.
type meetingClient struct {
	*oneFileClient
	inflight, most *atomic.Int32
}

func (c *meetingClient) List(p string) ([]remote.Entry, error) {
	n := c.inflight.Add(1)
	defer c.inflight.Add(-1)
	for {
		if m := c.most.Load(); n <= m || c.most.CompareAndSwap(m, n) {
			break
		}
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for c.inflight.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return c.oneFileClient.List(p)
}

// Saving a watch starts a check, and "check now" right after starts another:
// both listed the folder at once, both found the file not queued yet, and
// both queued it. One watch runs one check at a time; the second waits for the
// first and then finds the file queued.
func TestWatchChecksOfOneWatchDoNotOverlap(t *testing.T) {
	d := dbtest.Open(t)
	root := t.TempDir()
	inflight, most := new(atomic.Int32), new(atomic.Int32)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &meetingClient{oneFileClient: &oneFileClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, inflight: inflight, most: most}, "", nil
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}
	drainJobsAtCleanup(t, s)
	for _, q := range []string{
		`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`,
		`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`,
		`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
			VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode) VALUES (1, 1, '/x/Show', 'Show', 'template')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	var wg sync.WaitGroup
	outs := make([]WatchCheckResponse, 2)
	for i := range outs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outs[i] = s.runWatch(t.Context(), 1)
		}()
	}
	wg.Wait()
	if m := most.Load(); m != 1 {
		t.Errorf("checks of one watch listing at once: %d, want 1", m)
	}
	for i, o := range outs {
		if o.Error != "" {
			t.Errorf("check %d: %+v", i, o)
		}
	}
	var rows int
	if err := d.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Errorf("download rows: %d, want the file queued once", rows)
	}
}
