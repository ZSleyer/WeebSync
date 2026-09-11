package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTrashEndpoints(t *testing.T) {
	mux, s, admin := setupAiTest(t, nil)
	s.DB.Exec(`INSERT INTO users (email, is_admin) VALUES ('b@example.com', 0)`)
	user := cookieForUser(t, s.DB, 2)
	root := s.DownloadRoot
	dir := filepath.Join(root, "Show", "Season 01")
	writeFiles(t, dir, map[string]int64{"Show - S01E01.mkv": 10, "Show - S01E01.en.srt": 2, "Show - S01E02.mkv": 10})
	old := filepath.Join(root, "Show", "Season 01 (old)")
	writeFiles(t, old, map[string]int64{"Show - S01E01.mkv": 5})
	if err := s.trashPath(filepath.Join(dir, "Show - S01E01.mkv")); err != nil {
		t.Fatal(err)
	}
	if err := s.trashPath(old); err != nil {
		t.Fatal(err)
	}
	trashedFile := filepath.Join(dir, trashDir, "Show - S01E01.mkv")
	trashedDir := filepath.Join(root, "Show", trashDir, "Season 01 (old)")

	list := func() []TrashEntry {
		t.Helper()
		rec := doReq(mux, "GET", "/api/trash", "", user)
		if rec.Code != 200 {
			t.Fatalf("list: %d %s", rec.Code, rec.Body)
		}
		var out []TrashEntry
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// the video and its sidecar are one entry, the folder another, sizes summed
	got := list()
	if len(got) != 2 {
		t.Fatalf("entries: %+v", got)
	}
	byPath := map[string]TrashEntry{}
	for _, e := range got {
		byPath[e.Path] = e
	}
	if e := byPath[trashedFile]; e.Files != 2 || e.Size != 12 || e.Dir != dir || e.IsDir || e.ExpiresAt != e.TrashedAt+14*86400 {
		t.Errorf("file entry: %+v", e)
	}
	if e := byPath[trashedDir]; !e.IsDir || e.Size != 5 || e.Files != 1 || e.Dir != filepath.Join(root, "Show") {
		t.Errorf("folder entry: %+v", e)
	}

	// the actions are admin only
	if rec := doReq(mux, "POST", "/api/trash/restore", `{"path":"`+trashedFile+`"}`, user); rec.Code != 403 {
		t.Errorf("restore as user: %d", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/trash", "", user); rec.Code != 403 {
		t.Errorf("delete as user: %d", rec.Code)
	}

	// a copy in the way blocks the restore before anything moves
	writeFiles(t, dir, map[string]int64{"Show - S01E01.mkv": 1})
	if rec := doReq(mux, "POST", "/api/trash/restore", `{"path":"`+trashedFile+`"}`, admin); rec.Code != 409 {
		t.Errorf("blocked restore: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, trashDir, "Show - S01E01.en.srt")); err != nil {
		t.Error("the sidecar must stay in the trash with its video")
	}
	os.Remove(filepath.Join(dir, "Show - S01E01.mkv"))

	// restore brings the sidecar along and clears the folder
	if rec := doReq(mux, "POST", "/api/trash/restore", `{"path":"`+trashedFile+`"}`, admin); rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body)
	}
	left := names(t, dir)
	if !left["Show - S01E01.mkv"] || !left["Show - S01E01.en.srt"] || left[trashDir] {
		t.Errorf("after restore: %v", left)
	}
	if rec := doReq(mux, "POST", "/api/trash/restore", `{"path":"`+trashedFile+`"}`, admin); rec.Code != 404 {
		t.Errorf("restore twice: %d", rec.Code)
	}
	if got := list(); len(got) != 1 || got[0].Path != trashedDir {
		t.Errorf("after restore the folder is all that is left: %+v", got)
	}

	// only a recorded path is ever touched
	if rec := doReq(mux, "DELETE", "/api/trash", `{"path":"/etc/passwd"}`, admin); rec.Code != 404 {
		t.Errorf("delete a stranger: %d", rec.Code)
	}
	if _, err := os.Stat("/etc/passwd"); err != nil {
		t.Fatal("touched /etc/passwd")
	}

	// delete one entry now, ahead of the sweep
	if rec := doReq(mux, "DELETE", "/api/trash", `{"path":"`+trashedDir+`"}`, admin); rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(root, "Show", trashDir)); !os.IsNotExist(err) {
		t.Error("the trash folder should be gone with its last entry")
	}

	// empty everything
	if err := s.trashPath(filepath.Join(dir, "Show - S01E02.mkv")); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "DELETE", "/api/trash", "", admin); rec.Code != 200 {
		t.Fatalf("empty: %d %s", rec.Code, rec.Body)
	}
	if got := list(); len(got) != 0 {
		t.Errorf("after emptying: %+v", got)
	}
	var rows int
	s.DB.QueryRow(`SELECT COUNT(*) FROM trash_files`).Scan(&rows)
	if rows != 0 {
		t.Errorf("rows left: %d", rows)
	}
}
