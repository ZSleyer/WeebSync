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

func TestReplaceOldCopyLeavesEpisodesAloneWithoutNumber(t *testing.T) {
	s, root := sizeTestServer(t)
	// an opening file next to the season's only episode: not a movie folder
	dir := filepath.Join(root, "Show", "Season 01")
	writeFiles(t, dir, map[string]int64{"Show - 01.mkv": 10, "Show - NCOP1.mkv": 5})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Show - NCOP1.mkv"), RemotePath: "/r/Show - NCOP1.mkv"})
	if left := names(t, dir); !left["Show - 01.mkv"] || len(left) != 2 {
		t.Errorf("episode trashed by a file without a number: %v", left)
	}
	// the opening as the OLD file: episode one arriving must not take it along
	writeFiles(t, dir, map[string]int64{"Show - S01E01.mkv": 20})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Show - S01E01.mkv"), RemotePath: "/r/Show - 01.mkv"})
	left := names(t, dir)
	if !left["Show - NCOP1.mkv"] || left["Show - 01.mkv"] {
		t.Errorf("want the opening kept and episode one replaced: %v", left)
	}
	// a flat show folder without episode numbers but named like a season
	dir = filepath.Join(root, "Show", "Season 02")
	writeFiles(t, dir, map[string]int64{"Show OVA.mkv": 10, "Show OVA v2.mkv": 12})
	s.replaceOldCopy(&transfer.Download{LocalPath: filepath.Join(dir, "Show OVA v2.mkv"), RemotePath: "/r/Show OVA v2.mkv"})
	if left := names(t, dir); len(left) != 2 {
		t.Errorf("season folder treated as a movie folder: %v", left)
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

func TestDuplicateTrashEndpoint(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	root := s.DownloadRoot
	dir := filepath.Join(root, "Show", "Season 01")
	writeFiles(t, dir, map[string]int64{"Show - S01E01.mkv": 10, "Show - S01E01 [v2].mkv": 12, "Show - S01E01 [v2].srt": 1, "Show - S01E02.mkv": 10})
	other := filepath.Join(root, "Show", "Season 01 (old)")
	writeFiles(t, other, map[string]int64{"Show - S01E01.mkv": 5})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season) VALUES (0, ?, 'tvdb:1', 1)`, other)

	// the doubled episode is reported with both files
	files := s.localEpisodeFiles(dir)
	if got := files[epKey(1, 1)]; len(got) != 2 {
		t.Fatalf("episode files: %+v", got)
	}

	// one file of the doubled episode, with its sidecar
	rec := doReq(mux, "POST", "/api/suggestions/duplicates/trash", `{"path":"`+filepath.Join(dir, "Show - S01E01 [v2].mkv")+`"}`, c)
	if rec.Code != 200 {
		t.Fatalf("file: %d %s", rec.Code, rec.Body)
	}
	left := names(t, dir)
	if left["Show - S01E01 [v2].mkv"] || left["Show - S01E01 [v2].srt"] || !left["Show - S01E01.mkv"] || !left["Show - S01E02.mkv"] {
		t.Errorf("after trashing one file: %v", left)
	}

	// a whole folder copy, and its index row goes with it
	rec = doReq(mux, "POST", "/api/suggestions/duplicates/trash", `{"path":"`+other+`"}`, c)
	if rec.Code != 200 {
		t.Fatalf("folder: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(other); !os.IsNotExist(err) {
		t.Error("folder should be gone from its place")
	}
	if _, err := os.Stat(filepath.Join(root, "Show", trashDir, "Season 01 (old)", "Show - S01E01.mkv")); err != nil {
		t.Error("folder should be in the trash with its file")
	}
	var rows int
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_variants WHERE folder = ?`, other).Scan(&rows)
	if rows != 0 {
		t.Error("index row should be dropped")
	}

	// a root is refused; a path outside the roots resolves under the root
	// (legacy relative form) and finds nothing there
	if rec = doReq(mux, "POST", "/api/suggestions/duplicates/trash", `{"path":"`+root+`"}`, c); rec.Code != 400 {
		t.Errorf("root: %d", rec.Code)
	}
	if rec = doReq(mux, "POST", "/api/suggestions/duplicates/trash", `{"path":"/etc/passwd"}`, c); rec.Code == 200 {
		t.Error("a path outside the roots must not be moved")
	}
	if _, err := os.Stat("/etc/passwd"); err != nil {
		t.Fatal("touched /etc/passwd")
	}

	// the sweep removes the folder as a whole
	s.DB.Exec(`UPDATE trash_files SET trashed_at = 0`)
	s.emptyTrash()
	if _, err := os.Stat(filepath.Join(root, "Show", trashDir)); !os.IsNotExist(err) {
		t.Error("trash folder should be gone after the sweep")
	}
}
