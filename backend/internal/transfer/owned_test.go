package transfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
)

// An episode the library holds under another name is left on the remote, and
// counted so the check can say why. One that sits at the target is ours: the
// owned verdict must not keep a re-release of another size from replacing it.
func TestEnqueueSkippingLeavesOwnedEpisodes(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "Show"), 0o700); err != nil {
		t.Fatal(err)
	}
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &multiClient{dir: "/x/Show", entries: []remote.Entry{
			{Name: "Show - S01E01.mkv", Path: "/x/Show/Show - S01E01.mkv", Size: 100},
			{Name: "Show - S01E02.mkv", Path: "/x/Show/Show - S01E02.mkv", Size: 100},
		}}, "", nil
	}
	m := NewManager(d, dial, root)
	owned := func(local string) bool { return strings.Contains(local, "S01E01") }

	res, err := m.EnqueueSkipping(1, 1, "/x/Show", "Show", nil, nil, owned, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 1 || res.Owned != 1 {
		t.Fatalf("queued %d, owned %d; want 1 and 1", len(res.IDs), res.Owned)
	}

	d.Exec(`DELETE FROM downloads`)
	if err := os.WriteFile(filepath.Join(root, "Show", "Show - S01E01.mkv"), make([]byte, 50), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = m.EnqueueSkipping(1, 1, "/x/Show", "Show", nil, nil, owned, false, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.IDs) != 2 || res.Owned != 0 {
		t.Fatalf("queued %d, owned %d; want the re-release and E02 queued, nothing owned", len(res.IDs), res.Owned)
	}
}
