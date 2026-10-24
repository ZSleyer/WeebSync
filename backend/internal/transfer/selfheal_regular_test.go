package transfer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// The stale-queue self-heal takes a target that is already there at full size
// for a finished download. A directory of the same name is no such file: its
// size is the filesystem's block size, which a small remote file can match
// byte for byte. Counting it as complete ended the download "done" with no
// file anywhere.
func TestSelfHealIgnoresDirectoryOfSameSize(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	target := filepath.Join(root, "Show", "ep01.srt")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	size := fi.Size() // whatever this filesystem reports for a directory
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.srt", size: size}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/Show/ep01.srt', ?, ?)`, target, size)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the download to end", func() bool {
		s := readRow(t, d, id).status
		return s == "done" || s == "error"
	})
	if r := readRow(t, d, id); r.status == "done" {
		t.Errorf("a directory at the target passed for the finished file (status %q)", r.status)
	}
}
