package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestBestCopyFor(t *testing.T) {
	uhd := UpgradeVariant{ServerID: 1, Folder: "/4k", ResRank: 2160, Dub: []string{"Jap"}, Sub: []string{"Ger"}}
	soft := UpgradeVariant{ServerID: 1, Folder: "/soft", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Ger"}, Soft: []string{"Ger"}}
	if got := bestCopyFor([]string{"soft", "res"}, []UpgradeVariant{uhd, soft}); got.Folder != "/soft" {
		t.Errorf("soft first: got %s", got.Folder)
	}
	if got := bestCopyFor([]string{"res", "soft"}, []UpgradeVariant{soft, uhd}); got.Folder != "/4k" {
		t.Errorf("res first: got %s", got.Folder)
	}
	// nothing enabled: the fixed order (resolution first) decides
	if got := bestCopyFor(nil, []UpgradeVariant{soft, uhd}); got.Folder != "/4k" {
		t.Errorf("no order: got %s", got.Folder)
	}
}

func TestBuildUpgradesOrdersByTopAxis(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`UPDATE users SET upgrade_dims = 'dub,res' WHERE id = 1`)
	// Alpha gains resolution, Beta gains a dub: with dubs ranked first Beta leads
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed) VALUES (0, '/lib/Alpha/Season 01', 1080, 'Jap', 'Ger', 'tvdb:1', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed) VALUES (1, '/seed/Alpha 4K', 2160, 'Jap', 'Ger', 'tvdb:1', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed) VALUES (0, '/lib/Beta/Season 01', 1080, 'Jap', 'Ger', 'tvdb:2', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, probed) VALUES (1, '/seed/Beta GerDub', 1080, 'Jap,Ger', 'Ger', 'tvdb:2', 1, 1)`)
	got := s.buildUpgrades(1)
	if len(got) != 2 || got[0].ShowKey != "tvdb:2" || !got[0].ImprovesDub || got[1].ShowKey != "tvdb:1" || !got[1].ImprovesRes {
		t.Fatalf("order: %+v", got)
	}
	s.DB.Exec(`UPDATE users SET upgrade_dims = 'res,dub' WHERE id = 1`)
	if got = s.buildUpgrades(1); len(got) != 2 || got[0].ShowKey != "tvdb:1" {
		t.Fatalf("order after flip: %+v", got)
	}
}

func TestUpgradeDimsPutKeepsOrderAndSoft(t *testing.T) {
	s, _ := sizeTestServer(t)
	mux := http.NewServeMux()
	s.Register(mux)
	c := cookieForUser(t, s.DB, 1)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('suggestions:1', '{"upgrades":[]}', '2000-01-01 00:00:00')`)
	rec := doReq(mux, "PUT", "/api/auth/upgrade-dims", `{"res":true,"sub":false,"dub":true,"soft":true,"order":["soft","res","sub"]}`, c)
	if rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	if d := s.upgradeDimsFor(1); strings.Join(d.Order, ",") != "soft,res,dub" || d.Sub || !d.Soft {
		t.Errorf("stored dims: %+v", d)
	}
	rec = doReq(mux, "GET", "/api/auth/upgrade-dims", "", c)
	if !jsonHas(rec.Body.Bytes(), `"order":["soft","res","dub"]`) {
		t.Errorf("get: %s", rec.Body)
	}
	// the old blob is gone; a rebuild may already have written a fresh one
	var fetched string
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&fetched)
	if fetched == "2000-01-01 00:00:00" {
		t.Error("stale suggestion blob survived the axis change")
	}
}
