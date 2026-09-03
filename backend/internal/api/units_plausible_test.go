package api

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
)

func folded(titles ...string) []string {
	out := make([]string, len(titles))
	for i, t := range titles {
		out[i] = match.FoldKey(match.StripMarkers(t))
	}
	return out
}

func TestCopyAgrees(t *testing.T) {
	conan := folded("Meitantei Conan", "Detektiv Conan", "Case Closed")
	cases := []struct {
		folder string
		years  []int
		want   bool
	}{
		{"/LA-Lounge/Filme-1080P/Skyscraper (2018)", []int{1996}, false},          // wrong film, wrong era
		{"/FTP/WEB/Detektiv Conan [GerDub,GerSub,CR]", []int{1996}, true},         // the show
		{"/FTP/BD/Meitantei Conan (Case Closed) S02 [JapDub]", []int{1996}, true}, // alt title in parens
		{"/media/x/Detektiv_Conan/Season_01", []int{1996}, true},                  // season folder: parent names it
		{"/LA-Lounge/Serien-1080P/One Piece (2022)", []int{1999}, false},          // not this show, and not its era
		{"/FTP/BD/Assassins (1995)", []int{2019}, false},                          // dated before the show began
		{"/FTP/WEB/Conan [tags]", []int{1996}, false},                             // one short word claims nothing
	}
	for _, c := range cases {
		if got := copyAgrees(c.folder, conan, c.years); got != c.want {
			t.Errorf("copyAgrees(%q) = %v, want %v", c.folder, got, c.want)
		}
	}
	// a later season's year is fine, a year the show never aired in is not
	haikyu := folded("Haikyuu!!", "HAIKYU!!")
	if !copyAgrees("/FTP/WEB/Haikyuu To the Top (2020) [JapDub]", haikyu, []int{2014, 2015, 2016, 2020}) {
		t.Error("a season's year should fit")
	}
	if copyAgrees("/LA-Lounge/Serien-1080P/Haikyuu (2035)", haikyu, []int{2014, 2015, 2016, 2020}) {
		t.Error("a year the show never aired in must not fit")
	}
	// an arc folder is named by the show folder above it
	if !copyAgrees("/FTP/One Piece/16 Elbaph (1156-1200) [JapDub]", folded("One Piece"), nil) {
		t.Error("the parent folder should name the show")
	}
	// no year known: the title decides alone
	if !copyAgrees("/FTP/WEB/Kyoukai no Kanata [GerJapDub]", folded("Beyond the Boundary", "Kyoukai no Kanata"), nil) {
		t.Error("romaji title from the series' stored titles should agree")
	}
	if copyAgrees("/LA-Lounge/Filme-1080P/Work It (2020)", folded("Cells at Work!!", "Hataraku Saibou!!"), []int{2021}) {
		t.Error("a shared word is not agreement")
	}
}

func TestPruneImplausibleRemotesKeepsUnjudgeable(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES (7, 'meitantei conan', 'Detektiv Conan', 1996)`)
	u := catUnits{byKey: map[string]*catUnit{}}
	cu := &catUnit{showKey: "tvdb:72454", season: 1, seriesID: 7,
		locals:  []UpgradeVariant{{ServerID: 0, Folder: "/media/x/Detektiv_Conan/Season_01"}},
		remotes: []UpgradeVariant{{ServerID: 1, Folder: "/LA-Lounge/Filme-1080P/Skyscraper (2018)"}, {ServerID: 1, Folder: "/FTP/WEB/Detektiv Conan S01 [CR]"}}}
	u.byKey["a"] = cu
	u.order = []string{"a"}
	// a unit nobody can judge (no series, no local folder) keeps its remotes
	bare := &catUnit{showKey: "fold:x", remotes: []UpgradeVariant{{ServerID: 1, Folder: "/FTP/Whatever"}}}
	u.byKey["b"] = bare
	u.order = append(u.order, "b")
	s.pruneImplausibleRemotes(u)
	if len(cu.remotes) != 1 || cu.remotes[0].Folder != "/FTP/WEB/Detektiv Conan S01 [CR]" {
		t.Errorf("remotes after pruning: %+v", cu.remotes)
	}
	if len(bare.remotes) != 1 {
		t.Error("an unjudgeable unit lost its remote")
	}
}

func TestOutermostCopies(t *testing.T) {
	s, root := sizeTestServer(t)
	writeFiles(t, root+"/Show/Season_01", map[string]int64{"Show - S01E01.mkv": 1})
	writeFiles(t, root+"/Show (old)", map[string]int64{"Show - S01E01.mkv": 1})
	writeFiles(t, root+"/Empty", map[string]int64{})
	got := outermostCopies(s, []UpgradeVariant{{Folder: root + "/Show"}, {Folder: root + "/Show/Season_01"}, {Folder: root + "/Show (old)"}, {Folder: root + "/Empty"}})
	if len(got) != 2 || got[0].Folder != root+"/Show/Season_01" || got[1].Folder != root+"/Show (old)" {
		t.Errorf("outermost copies: %+v", got)
	}
}

func TestRevalidateMatchesDropsWhatTheRulesRefuse(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	cache := func(id, year int, romaji, english string) {
		m := anilist.Media{ID: id, SeasonYear: year, Format: "TV", Status: "FINISHED", Schema: anilist.MediaSchema}
		m.Title.Romaji, m.Title.English = romaji, english
		b, _ := json.Marshal(m)
		s.cacheSet(fmt.Sprintf("media:%d", id), string(b))
	}
	cache(779, 1996, "Meitantei Conan", "Case Closed")
	cache(21, 1999, "One Piece", "One Piece")
	cache(154587, 2023, "Sousou no Frieren", "Frieren: Beyond Journey's End")
	for folder, id := range map[string]int{
		"/x/Skyscraper (2018)": 779,    // nothing agrees
		"/x/One Piece (2022)":  21,     // decades off
		"/x/Frieren [GerSub]":  154587, // fine
		"/x/Detektiv Conan":    779,    // fine
		"/x/Somebody (2001)":   779,    // manual: never touched
	} {
		s.persistMatch(1, folder, id, folder == "/x/Somebody (2001)", "anilist")
	}
	s.RevalidateMatches()
	got := map[string]int{}
	rows, _ := s.DB.Query(`SELECT folder, media_id FROM catalog_matches WHERE server_id = 1`)
	for rows.Next() {
		var f string
		var id int
		rows.Scan(&f, &id)
		got[f] = id
	}
	rows.Close()
	want := map[string]int{"/x/Skyscraper (2018)": 0, "/x/One Piece (2022)": 0, "/x/Frieren [GerSub]": 154587, "/x/Detektiv Conan": 779, "/x/Somebody (2001)": 779}
	for f, id := range want {
		if got[f] != id {
			t.Errorf("%s: media %d, want %d", f, got[f], id)
		}
	}
	// second run is a no-op (rule set recorded)
	s.persistMatch(1, "/x/Work It (2020)", 779, false, "anilist")
	s.RevalidateMatches()
	var id int
	s.DB.QueryRow(`SELECT media_id FROM catalog_matches WHERE folder = '/x/Work It (2020)'`).Scan(&id)
	if id != 779 {
		t.Error("the check must run once per rule set")
	}
}
