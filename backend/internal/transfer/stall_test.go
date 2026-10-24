package transfer

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// stallRow queues one download whose remote side stalls - in the dial when
// stallDial, else in the first read - until the test ends.
func stallRow(t *testing.T, stallDial bool) (*Manager, int64) {
	t.Helper()
	d := newRetryDB(t)
	gate := make(chan struct{})
	dialing := make(chan struct{}, 1)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		if stallDial {
			dialing <- struct{}{}
			<-gate
		}
		return &gateClient{size: 8, gate: gate}, "", nil
	}
	root := t.TempDir()
	m := NewManager(d, dial, root)
	t.Cleanup(func() {
		close(gate) // let the stalled call return, then drain
		m.Shutdown(t.Context())
	})
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, filepath.Join(root, "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()
	if stallDial {
		<-dialing
	} else {
		waitFor(t, "the read to stall", func() bool {
			_, err := filepath.Glob(filepath.Join(root, "*.part"))
			return err == nil && readRow(t, d, id).status == "running"
		})
		time.Sleep(50 * time.Millisecond) // into the blocked read
	}
	return m, id
}

// A peer that stalls - mid-read or mid-dial - held the worker until the call
// returned by itself, which with a silent connection could take as long as the
// kernel's TCP timeout. Pause and cancel answered "ok" and nothing happened:
// the row stayed running and kept its slot. They take effect at once; the
// stalled call is left to end on its own.
func TestPauseAndCancelReachAStalledDownload(t *testing.T) {
	for _, c := range []struct {
		name      string
		stallDial bool
		act       func(m *Manager, id int64) error
		want      string
	}{
		{"pause mid-read", false, func(m *Manager, id int64) error { return m.Pause(1, id) }, "paused"},
		{"cancel mid-read", false, func(m *Manager, id int64) error { return m.Cancel(1, id) }, "canceled"},
		{"cancel mid-dial", true, func(m *Manager, id int64) error { return m.Cancel(1, id) }, "canceled"},
	} {
		t.Run(c.name, func(t *testing.T) {
			m, id := stallRow(t, c.stallDial)
			if err := c.act(m, id); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				if readRow(t, m.DB, id).status == c.want && len(m.RunningRates()) == 0 {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Errorf("status %q, %d running, 2s after the request; want %s and the slot free",
				readRow(t, m.DB, id).status, len(m.RunningRates()), c.want)
		})
	}
}
