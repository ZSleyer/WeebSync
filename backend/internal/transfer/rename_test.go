package transfer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// A rename the filesystem refuses is the failure the user reports as "it
// downloaded but it will not rename". It has to end the download once, with a
// code of its own: calling it permission_denied points at the directory, which
// is demonstrably writable - every byte of the download went into it.
//
// The target name is taken by a directory here, because that is a refusal any
// filesystem produces. On a user's machine the same refusal comes from a share
// or a merged mount that cannot replace a file atomically.
func TestRenameFailureEndsTheDownloadOnce(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	target := filepath.Join(root, "Show", "ep01.mkv")
	if err := os.MkdirAll(target, 0o755); err != nil { // the final name is a directory
		t.Fatal(err)
	}
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8)`, target)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.Wake()

	waitFor(t, "the download to fail", func() bool { return readRow(t, d, id).status == "error" })
	r := readRow(t, d, id)
	if r.code != ErrCodeRenameFailed {
		t.Errorf("error_code %q, want %q (error %q)", r.code, ErrCodeRenameFailed, r.errMsg)
	}
	if r.attempts != 0 {
		t.Errorf("attempts %d, want 0: repeating a refused rename only buries the cause", r.attempts)
	}
	// the bytes stay: the user fixes the target and the retry renames them
	if fi, err := os.Stat(target + ".part"); err != nil || fi.Size() != 8 {
		t.Errorf("want the downloaded .part kept at full size, got %v / %v", fi, err)
	}
}
