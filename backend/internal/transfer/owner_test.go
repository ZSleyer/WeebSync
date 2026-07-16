package transfer

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// A running download must only be pausable/cancelable by its owner: the
// in-memory fastpath in Pause/Cancel must honor the userID.
func TestActivePauseCancelOwnerScoped(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	// download id 1 owned by user 1, status running
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status)
		VALUES (1, 1, '/x', 'x', 100, 'running')`)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()

	m := NewManager(d, nil, t.TempDir())
	_, cancel := context.WithCancel(context.Background())
	m.active[id] = &running{userID: 1, cancel: cancel}

	// foreign user hits the DB path, which is user-scoped -> ErrNotFound, and
	// the running download stays untouched
	if err := m.Pause(2, id); err != ErrNotFound {
		t.Errorf("foreign pause: got %v, want ErrNotFound", err)
	}
	if m.active[id].paused {
		t.Error("foreign pause flipped the paused flag")
	}
	// owner pauses via the fastpath
	if err := m.Pause(1, id); err != nil {
		t.Errorf("owner pause: got %v", err)
	}
	if !m.active[id].paused {
		t.Error("owner pause did not set the paused flag")
	}
}
