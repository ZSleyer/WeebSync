package api

import "testing"

func TestStacksTreatsSplitEpisodeAsOneCopy(t *testing.T) {
	f := func(names ...string) []DuplicateFile {
		out := make([]DuplicateFile, len(names))
		for i, n := range names {
			out[i] = DuplicateFile{Path: "/lib/Show/Season 01/" + n}
		}
		return out
	}
	if n := stacks(f("Detektiv_Conan_-_S01E11_(11).mp4", "Detektiv_Conan_-_S01E11_(11).pt2.mp4")); n != 1 {
		t.Errorf("pt2 continues pt1: %d stacks, want 1", n)
	}
	if n := stacks(f("Show - S01E03 - cd1.mkv", "Show - S01E03 - cd2.mkv", "Show - S01E03 part3.mkv")); n != 1 {
		t.Errorf("cd/part markers: %d stacks, want 1", n)
	}
	if n := stacks(f("Show - S01E11.mkv", "Show - S01E11 [v2].mkv")); n != 2 {
		t.Errorf("two releases: %d stacks, want 2", n)
	}
	if n := stacks(f("Show - S01E11.mp4", "Show - S01E11.pt2.mp4", "Show - S01E11 [BD].mkv")); n != 2 {
		t.Errorf("a stack beside another release: %d stacks, want 2", n)
	}
}

func TestShowKeyCanonKeepsTwoProviderIdsApart(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (5, 'fairy tail', 'Fairy Tail')`)
	for _, row := range [][]any{
		{0, "/lib/Fairy_Tail/Season_01", "tvdb:114801", 1},
		{0, "/lib/Fairy_Tail_100_Years_Quest/Season_01", "tvdb:410031", 1},
		{1, "/seed/Fairy Tail (Sequel) [tags]", "fold:fairy tail", 1},
	} {
		s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (?, ?, ?, ?, 5)`, row...)
	}
	canon := s.showKeyCanon()
	if _, folded := canon["tvdb:410031"]; folded {
		t.Errorf("the sequel's own tvdb id was folded onto the original: %v", canon)
	}
	if _, folded := canon["tvdb:114801"]; folded {
		t.Errorf("the original's id was folded: %v", canon)
	}
	// a series with one provider id still gathers its fold key
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (6, 'yani neko', 'Yani Neko')`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (0, '/lib/Cat/Season_01', 'tvdb:473423', 1, 6)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, show_key, season, series_id) VALUES (1, '/seed/Yani Neko', 'fold:yani neko', 1, 6)`)
	if got := s.showKeyCanon()["fold:yani neko"]; got != "tvdb:473423" {
		t.Errorf("fold key should fold onto the one provider id, got %q", got)
	}
}
