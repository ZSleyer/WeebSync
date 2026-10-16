package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// TVDB ranks an empty stub without a year first for a short title ("Best Bet"
// for "Bet"); a folder with a year takes only an entry that has one.
func TestPickLiveSkipsEntriesWithoutAYear(t *testing.T) {
	cands := []liveCand{{id: 274225, titles: []string{"Best Bet", "Bet"}}, {id: 450686, year: 2025, titles: []string{"Bet"}}}
	if got := pickLive("Bet (2025)", "Bet", cands); got != 450686 {
		t.Fatalf("picked %d, want the 2025 show", got)
	}
	if got := pickLive("Bet (2025)", "Bet", cands[:1]); got != 0 {
		t.Fatalf("picked the stub %d", got)
	}
	if got := pickLive("Bet", "Bet", cands[:1]); got != 274225 {
		t.Fatalf("a folder without a year has nothing to hold the stub to, got %d", got)
	}
	// what the dropped folders find instead, from TVDB's search
	if got := pickLive("1923 (2022)", GuessTitle("1923 (2022)"), []liveCand{
		{id: 342655, titles: []string{"Shackleton (1983)"}}, {id: 416491, year: 2022, titles: []string{"1923"}}}); got != 416491 {
		t.Fatalf("1923: picked %d", got)
	}
	if got := pickLive("Around the World in 80 Days (2021)", GuessTitle("Around the World in 80 Days (2021)"), []liveCand{
		{id: 84583, year: 1989, titles: []string{"Around the World in 80 Days"}},
		{id: 388899, year: 2021, titles: []string{"Around the World in 80 Days (2021)"}},
		{id: 259273, titles: []string{"Around The World In 80 Raves"}}}); got != 388899 {
		t.Fatalf("80 days: picked %d", got)
	}
}

// The first TVDB matcher filed year-tagged folders under such stubs; the
// revalidation drops them, and leaves AniList's entries without a year alone.
func TestMatchStaleDropsLiveEntriesWithoutAYear(t *testing.T) {
	var stub anilist.Media
	stub.Title.Romaji = "Shackleton (1983)"
	if got := matchStale("/LA/Serien/1923 (2022)", "tvdb", stub); got != "no-year" {
		t.Fatalf("tvdb stub: %q", got)
	}
	if got := matchStale("/LA/Serien/1923 (2022)", "anilist", stub); got != "" {
		t.Fatalf("anilist: %q", got)
	}
	if got := matchStale("/LA/Serien/Barbarians", "tvdb", stub); got != "" {
		t.Fatalf("folder without a year: %q", got)
	}
}

// Plex holds two shows called Doctor Who; the title key names only one of
// them, the TVDB id the series carries finds the right one.
func TestReconcilePlexFindsAShowByItsTVDBID(t *testing.T) {
	s := sourceTestServer(t)
	seedGuidIndex(t, s, `{"doctor who":{"tvdb":449991,"year":2023,"ratingKey":"23"},
		"tvdb:449991":{"tvdb":449991,"year":2023,"ratingKey":"23"},
		"tvdb:78804":{"tvdb":78804,"year":2005,"ratingKey":"5"},
		"tvdb:83232":{"tvdb":83232,"year":2008,"ratingKey":"8"}}`)
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES (1, 'doctor who', 'Doctor Who', 2005), (2, 'little britain usa', 'Little Britain USA', 2008)`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 78804, 1), ('tvdb', 83232, 2)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES
		(1, '/LA/Serien/Doctor Who (2005)', 'tvdb', 78804), (1, '/LA/Serien/Little Britain USA (2008)', 'tvdb', 83232)`)
	s.reconcilePlex(10)
	for series, rk := range map[int]int{1: 5, 2: 8} {
		var n int
		s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id = ? AND source = 'plex' AND media_id = ?`, series, rk).Scan(&n)
		if n != 1 {
			t.Fatalf("series %d not linked to Plex item %d", series, rk)
		}
	}
}
