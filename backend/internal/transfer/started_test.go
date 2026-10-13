package transfer

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// A run notes when it began and how far the row already was, for the
// history's duration and rate.
func TestStartNotesStartedAt(t *testing.T) {
	d := newRetryDB(t)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("connection reset by peer")
	}
	m := NewManager(d, dial, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, transferred)
		VALUES (1, 1, '/x/ep01.mkv', ?, 8, 3)`, filepath.Join(t.TempDir(), "ep01.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the first attempt", func() bool { return readRow(t, d, id).attempts == 1 })
	var started string
	var from int64
	if err := d.QueryRow(`SELECT started_at, start_bytes FROM downloads WHERE id = ?`, id).Scan(&started, &from); err != nil {
		t.Fatal(err)
	}
	if started == "" || from != 3 {
		t.Errorf("started_at %q, start_bytes %d; want a time and 3", started, from)
	}
}
