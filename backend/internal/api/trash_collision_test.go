package api

import (
	"os"
	"path/filepath"
	"testing"
)

// A second copy of the same name going to the trash replaced the first one
// there, and with it the row: the older copy was gone for good while the page
// still promised two weeks to restore it. Both now stay, each with its
// sidecars grouped to it.
func TestTrashKeepsACopyOfTheSameName(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	dir := filepath.Join(s.DownloadRoot, "Show")
	put := func(name, body string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("Show - S01E01.mkv", "720p")
	put("Show - S01E01.en.srt", "subs 720p")
	if err := s.trashPath(filepath.Join(dir, "Show - S01E01.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	put("Show - S01E01.mkv", "1080p")
	put("Show - S01E01.en.srt", "subs 1080p")
	if err := s.trashPath(filepath.Join(dir, "Show - S01E01.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	td := filepath.Join(dir, trashDir)
	got := map[string]string{}
	entries, err := os.ReadDir(td)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if b, err := os.ReadFile(filepath.Join(td, e.Name())); err == nil && e.Name() != ".plexignore" {
			got[string(b)] = e.Name()
		}
	}
	for _, body := range []string{"720p", "subs 720p", "1080p", "subs 1080p"} {
		if got[body] == "" {
			t.Errorf("the copy %q is gone from the trash: %v", body, got)
		}
	}
	paths, _, err := s.trashRows()
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 4 {
		t.Errorf("rows: %v, want four (two videos, two sidecars)", paths)
	}
	// each video takes its own sidecar along
	for _, video := range []string{got["720p"], got["1080p"]} {
		group, err := s.trashGroup(filepath.Join(td, video))
		if err != nil || len(group) != 2 {
			t.Errorf("group of %s: %v %v, want the video and its sidecar", video, group, err)
		}
	}

	// a folder of the same name, twice
	season := filepath.Join(dir, "Season 01")
	for _, body := range []string{"first", "second"} {
		if err := os.MkdirAll(season, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(season, "ep.mkv"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := s.trashPath(season, trashWhy{Reason: "duplicate"}); err != nil {
			t.Fatalf("trash folder %s: %v", body, err)
		}
	}
	found := map[string]bool{}
	entries, _ = os.ReadDir(td)
	for _, e := range entries {
		if b, err := os.ReadFile(filepath.Join(td, e.Name(), "ep.mkv")); err == nil {
			found[string(b)] = true
		}
	}
	if !found["first"] || !found["second"] {
		t.Errorf("trashed folders: %v, want both", found)
	}
}
