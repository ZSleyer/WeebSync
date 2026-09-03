package api

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAddMissingEpisodesFindsGapsAndTail(t *testing.T) {
	s, root := sizeTestServer(t)
	local := filepath.Join(root, "Serien", "Show", "Season 01")
	writeFiles(t, local, map[string]int64{
		"Show - S01E01.mkv": 10, "Show - S01E02.mkv": 10, "Show - S01E03.mkv": 10, "Show - S01E05.mkv": 10,
	})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (0, ?, 1080, 'tvdb:7', 1, 1)`, local)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (1, '/seed/Show S1', 1080, 'tvdb:7', 1, 1)`)
	files := map[string]int64{}
	for i := 1; i <= 8; i++ {
		files["Show - 0"+string(rune('0'+i))+".mkv"] = 10
	}
	addRemoteFiles(t, s, 1, "/seed/Show S1", files)
	// a second copy numbered absolutely does not fit the season and is ignored
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (1, '/seed/Show Absolute', 1080, 'tvdb:7', 1, 1)`)
	addRemoteFiles(t, s, 1, "/seed/Show Absolute", map[string]int64{"Show - 1180.mkv": 10, "Show - 1187.mkv": 10})
	// a Plex-only local copy has nothing to read
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (0, 'plex:99:s2', 1080, 'tvdb:7', 2, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, probed) VALUES (1, '/seed/Show S2', 1080, 'tvdb:7', 2, 1)`)
	addRemoteFiles(t, s, 1, "/seed/Show S2", map[string]int64{"Show - 01.mkv": 10})

	acc := newAcc()
	s.addMissingEpisodes(acc)
	got := acc.list(nil)
	if len(got) != 1 {
		t.Fatalf("want one episodes item, got %d: %+v", len(got), got)
	}
	it := got[0]
	if it.Kind != "episodes" || !strings.HasPrefix(it.RefKey, "eps:unit:tvdb:7:1") {
		t.Errorf("kind/key: %s %s", it.Kind, it.RefKey)
	}
	if want := []int{4, 6, 7, 8}; len(it.Missing) != 4 || it.Missing[0] != 4 || it.Missing[3] != 8 {
		t.Errorf("missing = %v, want %v", it.Missing, want)
	}
	if it.Have != 4 || it.Need != 8 {
		t.Errorf("have/need = %d/%d", it.Have, it.Need)
	}
	if len(it.Candidates) != 1 || it.Candidates[0].Path != "/seed/Show S1" {
		t.Errorf("candidates: %+v", it.Candidates)
	}
	if it.Sync.LocalPath != local || it.Sync.Template != "{title} - S01E{episode:02}" {
		t.Errorf("sync plan: %+v", it.Sync)
	}
}

func TestDedupIncompleteKeepsEpisodesBesideSequel(t *testing.T) {
	items := []SugItem{
		{RefKey: "unit:x:2", Kind: "season", Title: "Show"},
		{RefKey: "series:1", Kind: "sequel", Title: "Show"},
		{RefKey: "eps:unit:x:1", Kind: "episodes", Title: "Show"},
	}
	got := dedupIncomplete(items)
	if len(got) != 2 || got[0].Kind != "season" || got[1].Kind != "episodes" {
		t.Fatalf("dedup: %+v", got)
	}
}
