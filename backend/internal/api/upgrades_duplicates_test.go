package api

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAddDuplicates(t *testing.T) {
	s, root := sizeTestServer(t)
	a := filepath.Join(root, "Anime", "Show", "Season 01")
	b := filepath.Join(root, "Anime4K", "Show", "Season 01")
	writeFiles(t, a, map[string]int64{"Show - S01E01.mkv": 100, "Show - S01E02.mkv": 100})
	writeFiles(t, b, map[string]int64{"Show - S01E01.mkv": 400, "Show - S01E02.mkv": 400, "Show - S01E02 [v2].mkv": 400})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (0, ?, 1080, 'tvdb:7', 1, 1)`, a)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (0, ?, 2160, 'tvdb:7', 1, 1)`, b)

	got := s.addDuplicates("en")
	if len(got) != 2 {
		t.Fatalf("want a folder duplicate and an episode duplicate, got %d: %+v", len(got), got)
	}
	var dup, ep *DuplicateItem
	for i := range got {
		if strings.HasPrefix(got[i].RefKey, "dup:") {
			dup = &got[i]
		} else {
			ep = &got[i]
		}
	}
	if dup == nil || len(dup.Copies) != 2 || dup.Keep != b {
		t.Fatalf("folder duplicate: %+v", dup)
	}
	for _, c := range dup.Copies {
		if c.Folder == b && (c.Files != 3 || c.Bytes != 1200) {
			t.Errorf("copy stats: %+v", c)
		}
	}
	if ep == nil || len(ep.Episodes) != 1 || ep.Episodes[0] != 2 || len(ep.Copies) != 1 || ep.Copies[0].Folder != b {
		t.Fatalf("episode duplicate: %+v", ep)
	}
}
