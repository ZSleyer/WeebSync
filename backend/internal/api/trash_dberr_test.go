package api

import (
	"os"
	"path/filepath"
	"testing"
)

// The trash table cannot be read (a lock held too long, a broken file): the
// list must not answer "empty", a restore not "not in the trash", and the
// delete not "ok" with nothing deleted.
func TestTrashReadFailureIsAnError(t *testing.T) {
	mux, s, admin := setupAiTest(t, nil)
	dir := filepath.Join(s.DownloadRoot, "Show")
	writeFiles(t, dir, map[string]int64{"Show - S01E01.mkv": 10})
	if err := s.trashPath(filepath.Join(dir, "Show - S01E01.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	trashed := filepath.Join(dir, trashDir, "Show - S01E01.mkv")
	if _, err := s.DB.Exec(`ALTER TABLE trash_files RENAME TO trash_files_gone`); err != nil {
		t.Fatal(err)
	}

	if rec := doReq(mux, "GET", "/api/trash", "", admin); rec.Code != 500 {
		t.Errorf("list: %d %s, want 500", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/trash/restore", `{"path":"`+trashed+`"}`, admin); rec.Code != 500 {
		t.Errorf("restore: %d %s, want 500", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "DELETE", "/api/trash", `{"path":"`+trashed+`"}`, admin); rec.Code != 500 {
		t.Errorf("delete one: %d %s, want 500", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "DELETE", "/api/trash", "", admin); rec.Code == 200 {
		t.Errorf("empty: %d %s, must not report success", rec.Code, rec.Body)
	}
	if _, err := os.Stat(trashed); err != nil {
		t.Errorf("the trashed copy must still be there: %v", err)
	}
}
