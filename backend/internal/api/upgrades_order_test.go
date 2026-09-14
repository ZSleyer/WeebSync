package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestBestCopyFor(t *testing.T) {
	uhd := UpgradeVariant{ServerID: 1, Folder: "/4k", ResRank: 2160, Dub: []string{"Jap"}, Sub: []string{"Ger"}}
	soft := UpgradeVariant{ServerID: 1, Folder: "/soft", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Ger"}, Soft: []string{"Ger"}}
	if got := bestCopyFor([]string{"soft", "res"}, wantedLangs{}, []UpgradeVariant{uhd, soft}); got.Folder != "/soft" {
		t.Errorf("soft first: got %s", got.Folder)
	}
	if got := bestCopyFor([]string{"res", "soft"}, wantedLangs{}, []UpgradeVariant{soft, uhd}); got.Folder != "/4k" {
		t.Errorf("res first: got %s", got.Folder)
	}
	// nothing enabled: the fixed order (resolution first) decides
	if got := bestCopyFor(nil, wantedLangs{}, []UpgradeVariant{soft, uhd}); got.Folder != "/4k" {
		t.Errorf("no order: got %s", got.Folder)
	}
}

// Two remote copies, the user asks for German subtitles: the one that has them
// wins, however many languages the other one names. The raw count recommended
// the fuller set, which is the wrong copy for anyone with a preference.
func TestBestCopyForPrefersTheAskedLanguage(t *testing.T) {
	ger := UpgradeVariant{ServerID: 1, Folder: "/ger", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Ger"}, Soft: []string{"Ger"}}
	many := UpgradeVariant{ServerID: 1, Folder: "/many", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Eng", "Spa"}, Soft: []string{"Eng", "Spa"}}
	want := wantedLangs{dub: []string{"Jap"}, sub: []string{"Ger"}}
	if got := bestCopyFor([]string{"soft", "sub"}, want, []UpgradeVariant{many, ger}); got.Folder != "/ger" {
		t.Errorf("asked language should win: got %s", got.Folder)
	}
	// no preference stated: the count decides, exactly as before
	if got := bestCopyFor([]string{"soft", "sub"}, wantedLangs{}, []UpgradeVariant{ger, many}); got.Folder != "/many" {
		t.Errorf("without a preference the count decides: got %s", got.Folder)
	}
}

// A copy that only adds a language nobody asked for is not an upgrade: it is a
// bigger file carrying a track that will never be selected.
func TestGainsNeedsTheAskedLanguage(t *testing.T) {
	if gains([]string{"Ger"}, []string{"Jap", "Spa"}, []string{"Jap"}) {
		t.Error("a Spanish dub counted as a gain for a German-subtitle viewer")
	}
	if !gains([]string{"Ger"}, []string{"Jap", "Ger"}, []string{"Jap"}) {
		t.Error("the asked language was not counted as a gain")
	}
	// nothing stated: every added language still counts
	if !gains(nil, []string{"Jap", "Spa"}, []string{"Jap"}) {
		t.Error("without a preference any added language is a gain")
	}
	// never a gain when the copy trades one language for another
	if gains(nil, []string{"Ger"}, []string{"Jap"}) {
		t.Error("a swapped language counted as a gain")
	}
	// The shape that dominates a real library: the copy already carries the
	// subtitles that were asked for and the remote one only adds English on
	// top. Counting that as an upgrade is what buries the handful of cards
	// that do bring something.
	if gains([]string{"Ger"}, []string{"Eng", "Ger"}, []string{"Ger"}) {
		t.Error("an added English track counted as a gain for a German viewer")
	}
	// and the shape that must survive: the subtitles are not there at all yet
	if !gains([]string{"Ger"}, []string{"Eng", "Ger"}, nil) {
		t.Error("subtitles the library does not have were not counted as a gain")
	}
}

// The preference is read from both halves of the defaults, and "off" is a
// decision about subtitles rather than a language.
func TestWantedFrom(t *testing.T) {
	w := wantedFrom(CommonDefaults{WantDub: "Jap", PlexSubLang: "Ger:forced"})
	if len(w.dub) != 1 || w.dub[0] != "Jap" || len(w.sub) != 1 || w.sub[0] != "Ger" {
		t.Fatalf("wanted: %+v", w)
	}
	if w := wantedFrom(CommonDefaults{PlexSubLang: "off"}); len(w.sub) != 0 {
		t.Errorf("off is not a language: %+v", w)
	}
	if w := wantedFrom(CommonDefaults{}); len(w.dub) != 0 || len(w.sub) != 0 {
		t.Errorf("nothing stated: %+v", w)
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
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('suggestions:1', '{"upgrades":[]}', '2030-01-01 00:00:00')`)
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
	// the old blob is aged so the next read rebuilds behind it (it stays
	// on screen meanwhile); a rebuild may already have written a fresh one
	var fetched string
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&fetched)
	if fetched == "2030-01-01 00:00:00" {
		t.Error("the suggestion blob still counts as fresh after the axis change")
	}
}
