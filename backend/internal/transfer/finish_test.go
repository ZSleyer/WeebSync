package transfer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// The ordinary ending: the .part file is gone, the episode carries its final
// name and its full size. The handle has to be closed before the rename for
// that to hold on a share, and a discarded Close error would let a short file
// pass for a complete one - neither is visible from the outside, but a
// leftover .part beside a finished download is.
func TestDownloadLeavesNoPartFile(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	target := filepath.Join(root, "Show", "ep01.mkv")
	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8)`, target)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the download to finish", func() bool { return readRow(t, d, id).status == "done" })
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatalf("the finished file is missing: %v", err)
	}
	if fi.Size() != 8 {
		t.Errorf("size %d, want 8", fi.Size())
	}
	if _, err := os.Stat(target + ".part"); !os.IsNotExist(err) {
		t.Errorf("the .part file is still there (err %v)", err)
	}
}
