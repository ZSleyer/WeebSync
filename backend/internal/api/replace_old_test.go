package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/transfer"
)

func names(t *testing.T, dir string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		out[e.Name()] = true
	}
	return out
}

func TestReplaceOldCopyEpisode(t *testing.T) {
	s, root := sizeTestServer(t)
	dir := filepath.Join(root, "Show", "Season 01")
	writeFiles(t, dir, map[string]int64{
		"Show - 01.mkv":      10, // the copy being upgraded
		"Show - 01.ger.srt":  1,  // its sidecar
		"Show - 01.5.mkv":    10, // recap, shares the stem prefix but is a video
		"Show - 02.mkv":      10, // another episode
		"Show - 01-02.mkv":   10, // multi-episode file
		"Show - S01E01.mkv":  20, // the new file
		"Show - S02E01.mkv":  10, // same number, other season
		"Show - S01E01.part": 5,  // not a video
	})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Show - S01E01.mkv"), RemotePath: "/r/Show - 01 [1080p].mkv"})

	left := names(t, dir)
	for _, keep := range []string{"Show - 01.5.mkv", "Show - 02.mkv", "Show - 01-02.mkv", "Show - S01E01.mkv", "Show - S02E01.mkv", "Show - S01E01.part"} {
		if !left[keep] {
			t.Errorf("%s should stay", keep)
		}
	}
	trash := names(t, filepath.Join(dir, trashDir))
	for _, gone := range []string{"Show - 01.mkv", "Show - 01.ger.srt"} {
		if left[gone] || !trash[gone] {
			t.Errorf("%s should be in the trash, left=%v trash=%v", gone, left[gone], trash[gone])
		}
	}
	if !trash[".plexignore"] {
		t.Error("trash folder needs its .plexignore")
	}
	var rows int
	s.DB.QueryRow(`SELECT COUNT(*) FROM trash_files`).Scan(&rows)
	if rows != 2 {
		t.Fatalf("trash_files rows = %d, want 2", rows)
	}

	// the walkers must not count what waits in the trash
	if got := s.localEpisodeCounts(dir, 0); got[epKey(1, 1)] != 1 {
		t.Errorf("episode 1 counted %d times, want 1 (trash must be skipped)", got[epKey(1, 1)])
	}

	// grace period not over: nothing deleted
	s.emptyTrash()
	if !names(t, filepath.Join(dir, trashDir))["Show - 01.mkv"] {
		t.Fatal("trash emptied before its grace period")
	}
	s.DB.Exec(`UPDATE trash_files SET trashed_at = ?`, time.Now().Add(-trashTTL-time.Hour).Unix())
	s.emptyTrash()
	if _, err := os.Stat(filepath.Join(dir, trashDir)); !os.IsNotExist(err) {
		t.Errorf("trash folder should be gone after the sweep, err=%v", err)
	}
	s.DB.QueryRow(`SELECT COUNT(*) FROM trash_files`).Scan(&rows)
	if rows != 0 {
		t.Errorf("trash_files rows after sweep = %d", rows)
	}
}

func TestReplaceOldCopyMovie(t *testing.T) {
	s, root := sizeTestServer(t)
	dir := filepath.Join(root, "Movies", "Film (2010)")
	writeFiles(t, dir, map[string]int64{"Film.2010.720p.mkv": 10, "Film (2010).mkv": 20})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Film (2010).mkv"), RemotePath: "/r/Film.2010.1080p.mkv"})
	if left := names(t, dir); left["Film.2010.720p.mkv"] || !left["Film (2010).mkv"] {
		t.Errorf("the one other video should be replaced, left=%v", left)
	}

	// several other videos: not the one-film layout, hands off
	dir = filepath.Join(root, "Movies", "Other (2011)")
	writeFiles(t, dir, map[string]int64{"Other.mkv": 10, "Other-trailer.mkv": 1, "Other (2011).mkv": 20})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Other (2011).mkv"), RemotePath: "/r/Other.mkv"})
	if left := names(t, dir); len(left) != 3 {
		t.Errorf("ambiguous movie folder touched: %v", left)
	}
}

func TestEmptyTrashStaysInsideTrash(t *testing.T) {
	s, root := sizeTestServer(t)
	victim := filepath.Join(root, "keep.mkv")
	writeFiles(t, root, map[string]int64{"keep.mkv": 1})
	s.DB.Exec(`INSERT INTO trash_files (path, trashed_at) VALUES (?, 0)`, victim)
	s.emptyTrash()
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("a row outside a trash folder must never delete the file")
	}
	var rows int
	s.DB.QueryRow(`SELECT COUNT(*) FROM trash_files`).Scan(&rows)
	if rows != 0 {
		t.Error("the bogus row should be dropped")
	}
}
