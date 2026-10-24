package api

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// A video's sidecars are the files that carry its stem and then a dot. With
// unpadded numbers "Show - 1" is the start of "Show - 10.ass", and with the
// .5 release convention "Show - 1." is the start of "Show - 1.5.ass": trashing
// episode 1 must take neither along, the list must not group them with it,
// and restoring or deleting it must leave them alone.
func TestTrashSidecarsBelongToTheirOwnEpisode(t *testing.T) {
	mux, s, admin := setupAiTest(t, nil)
	dir := filepath.Join(s.DownloadRoot, "Show")
	writeFiles(t, dir, map[string]int64{
		"Show - 1.mkv": 10, "Show - 1.ass": 1,
		"Show - 10.mkv": 10, "Show - 10.ass": 1,
		"Show - 1.5.mkv": 10, "Show - 1.5.ass": 1,
	})
	if err := s.trashPath(filepath.Join(dir, "Show - 1.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	left := names(t, dir)
	for _, n := range []string{"Show - 10.ass", "Show - 1.5.ass", "Show - 10.mkv", "Show - 1.5.mkv"} {
		if !left[n] {
			t.Errorf("%s went to the trash with episode 1: %v", n, left)
		}
	}
	if left["Show - 1.ass"] {
		t.Error("episode 1's own sidecar should go with it")
	}

	// episode 1.5 follows into the same trash folder: the groups stay apart
	if err := s.trashPath(filepath.Join(dir, "Show - 1.5.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	td := filepath.Join(dir, trashDir)
	group, err := s.trashGroup(filepath.Join(td, "Show - 1.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	if len(group) != 2 {
		t.Errorf("group of episode 1: %v, want the video and Show - 1.ass", group)
	}
	rec := doReq(mux, "GET", "/api/trash", "", admin)
	var list []TrashEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for _, e := range list {
		if e.Files != 2 {
			t.Errorf("entry %s holds %d files, want 2", e.Name, e.Files)
		}
	}
	// deleting episode 1 leaves 1.5 and its sidecar in the trash
	if rec := doReq(mux, "DELETE", "/api/trash", `{"path":"`+filepath.Join(td, "Show - 1.mkv")+`"}`, admin); rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if in := names(t, td); !in["Show - 1.5.mkv"] || !in["Show - 1.5.ass"] {
		t.Errorf("episode 1.5 lost files with episode 1: %v", in)
	}
}
