package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A media disk that is not mounted when the sweep runs must not cost the trash
// its rows: the files are still in their .weebsync-trash folders, and without
// a row nothing would ever list, restore or delete them again.
func TestEmptyTrashKeepsRowsOfAnUnmountedDisk(t *testing.T) {
	media := filepath.Join(t.TempDir(), "media")
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, DownloadRoot: t.TempDir(), LocalRoots: []string{media}, Anilist: anilist.New(d)})
	show := filepath.Join(media, "Show")
	writeFiles(t, show, map[string]int64{"Show - S01E01.mkv": 3, "Show - S01E02.mkv": 3})
	for _, n := range []string{"Show - S01E01.mkv", "Show - S01E02.mkv"} {
		if err := s.trashPath(filepath.Join(show, n), trashWhy{Reason: "upgrade"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.Exec(`UPDATE trash_files SET trashed_at = 0`); err != nil {
		t.Fatal(err)
	}
	rows := func() int {
		t.Helper()
		var n int
		if err := d.QueryRow(`SELECT COUNT(*) FROM trash_files`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	hidden := media + ".away"

	// the disk is gone: the root itself cannot be opened
	if err := os.Rename(media, hidden); err != nil {
		t.Fatal(err)
	}
	s.emptyTrash()
	if n := rows(); n != 2 {
		t.Fatalf("rows after a sweep without the disk: %d, want 2", n)
	}
	// the mount point is there, empty: the show folder is not
	if err := os.Mkdir(media, 0o755); err != nil {
		t.Fatal(err)
	}
	s.emptyTrash()
	if n := rows(); n != 2 {
		t.Fatalf("rows after a sweep over an empty mount point: %d, want 2", n)
	}
	// the disk is back: the sweep deletes the copies and their rows
	if err := os.Remove(media); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(hidden, media); err != nil {
		t.Fatal(err)
	}
	// one copy was removed by hand meanwhile: its folder is there, so the row
	// for it is done with
	if err := os.Remove(filepath.Join(show, trashDir, "Show - S01E02.mkv")); err != nil {
		t.Fatal(err)
	}
	s.emptyTrash()
	if n := rows(); n != 0 {
		t.Errorf("rows after the disk came back: %d, want 0", n)
	}
	if _, err := os.Stat(filepath.Join(show, trashDir, "Show - S01E01.mkv")); !os.IsNotExist(err) {
		t.Errorf("the expired copy should be deleted: %v", err)
	}
}
