package transfer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// foreignFixture: an admin (1) and a member (2), each with a server, and a
// library file at Show/ep01.mkv that nobody's download put there.
func foreignFixture(t *testing.T) (*Manager, string, string) {
	t.Helper()
	d := newRetryDB(t) // user 1 (admin), server 1
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('m@example.com', 0)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (2, 'own', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	root := t.TempDir()
	target := filepath.Join(root, "Show", "ep01.mkv")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("library"), 0o644); err != nil {
		t.Fatal(err)
	}
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 16}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	return m, root, target
}

// Replacing a file in the shared library is an admin's call (SECURITY.md,
// least privilege). A member's download or one-off sync could name any path
// under the roots as its target and, with a remote file of another size from a
// server of their own, replace another user's episode - the media server then
// played whatever they had put up. A member may still replace what their own
// downloads put there; an admin keeps replacing re-releases as before.
func TestMemberCannotQueueOverForeignFile(t *testing.T) {
	m, _, target := foreignFixture(t)
	m.DB.Exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	m.SettingsChanged()

	res, err := m.Enqueue(2, 2, "/x/Show", "Show", nil, nil, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 0 || len(res.Skips) != 1 || res.Skips[0].Reason != "foreign_target" {
		t.Fatalf("member over a foreign file: ids %v skips %+v, want one foreign_target skip", res.IDs, res.Skips)
	}

	// their own earlier download put it there: theirs to replace
	m.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status)
		VALUES (2, 2, '/x/Show/ep01.mkv', ?, 7, 'done')`, target)
	if res, err := m.Enqueue(2, 2, "/x/Show", "Show", nil, nil, false, true, false); err != nil || len(res.IDs) != 1 {
		t.Fatalf("member over their own file: ids %v err %v, want it queued", res.IDs, err)
	}
	m.DB.Exec(`DELETE FROM downloads`)

	if res, err := m.Enqueue(1, 1, "/x/Show", "Show", nil, nil, false, true, false); err != nil || len(res.IDs) != 1 {
		t.Fatalf("admin over a library file: ids %v err %v, want it queued", res.IDs, err)
	}
}

// The same guard at the end of the download: the queue may be older than the
// file, or the row may have been written by another route.
func TestMemberDownloadDoesNotReplaceForeignFile(t *testing.T) {
	for _, c := range []struct {
		name    string
		user    int64
		replace bool
	}{{"member", 2, false}, {"admin", 1, true}} {
		t.Run(c.name, func(t *testing.T) {
			m, _, target := foreignFixture(t)
			res, err := m.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
				VALUES (?, ?, '/x/Show/ep01.mkv', ?, 16)`, c.user, c.user, target)
			if err != nil {
				t.Fatal(err)
			}
			id, _ := res.LastInsertId()
			m.Wake()
			waitFor(t, "the download to end", func() bool {
				s := readRow(t, m.DB, id).status
				return s == "done" || s == "error"
			})
			got, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			r := readRow(t, m.DB, id)
			if c.replace {
				if r.status != "done" || len(got) != 16 {
					t.Errorf("admin: status %q, file %q; want done and replaced", r.status, got)
				}
				return
			}
			if r.status != "error" || r.code != ErrCodeForeignTarget || string(got) != "library" {
				t.Errorf("member: status %q code %q, file %q; want error %s and the library file untouched",
					r.status, r.code, got, ErrCodeForeignTarget)
			}
		})
	}
}
