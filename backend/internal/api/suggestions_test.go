package api

import (
	"fmt"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func mediaFmt(f string) anilist.Media { return anilist.Media{Format: f} }

func TestCategorize(t *testing.T) {
	cases := []struct {
		providers []string
		format    string
		source    string
		kind      string
		want      string
	}{
		// undecided: the old guess from the badges still applies
		{[]string{"anilist", "tvdb"}, "TV", "anilist", "", "anime-tv"},
		{[]string{"anilist"}, "MOVIE", "anilist", "", "anime-movie"},
		{[]string{"tmdb"}, "TV", "tmdb:tv", "", "tv"},
		{[]string{"tmdb"}, "MOVIE", "tmdb:movie", "", "movie"},
		{[]string{"tvdb"}, "TV", "tvdb", "", "anime-tv"},
		{[]string{"anilist"}, "OVA", "anilist", "", "anime-tv"}, // non-movie anime -> tv
		{[]string{"tmdb", "plex"}, "TV", "tmdb:tv", "", "tv"},   // plex badge doesn't make it anime
		// decided: the series settles it, whatever the badges say. This is the
		// case the Plex bridge creates - it hands a tvdb id to live action too.
		{[]string{"tvdb", "plex"}, "TV", "", kindLive, "tv"},
		{[]string{"tvdb"}, "TV", "tvdb", kindLive, "tv"},
		{[]string{"tmdb"}, "TV", "tmdb:tv", kindAnime, "anime-tv"},
		{[]string{"tmdb"}, "MOVIE", "tmdb:movie", kindAnime, "anime-movie"},
	}
	for _, c := range cases {
		if got := categorize(c.providers, mediaFmt(c.format), c.source, c.kind); got != c.want {
			t.Errorf("categorize(%v,%s,%s,%s)=%s want %s", c.providers, c.format, c.source, c.kind, got, c.want)
		}
	}
}

func TestSugAccDedup(t *testing.T) {
	a := newAcc()
	base := SugItem{RefKey: "series:1", Title: "Show", Providers: []string{"anilist"}, Candidates: []plexCandidate{{ServerID: 1, Path: "/a"}}}
	a.add(base)
	// same series from another provider: union providers + candidates, no dup entry
	a.add(SugItem{RefKey: "series:1", Title: "Show", Providers: []string{"tmdb"}, Candidates: []plexCandidate{{ServerID: 2, Path: "/b"}, {ServerID: 1, Path: "/a"}}})
	list := a.list(map[string]bool{})
	if len(list) != 1 {
		t.Fatalf("want 1 merged item, got %d", len(list))
	}
	if len(list[0].Providers) != 2 {
		t.Errorf("want 2 providers, got %v", list[0].Providers)
	}
	if len(list[0].Candidates) != 2 {
		t.Errorf("want 2 candidates, got %d", len(list[0].Candidates))
	}
	// dismissed filter
	if n := len(a.list(map[string]bool{"series:1": true})); n != 0 {
		t.Errorf("dismissed item should be hidden, got %d", n)
	}
}

// providerLinks is the pure half of providerBadgesLinks; the queue view relies
// on it staying free of the Plex library walk.
func TestProviderLinks(t *testing.T) {
	set, l := providerLinks([]providerRef{
		{"anilist", 42}, {"tmdb:tv", 100}, {"tvdb", 200}, {"imdb", 300},
	})
	for _, want := range []string{"anilist", "tmdb", "tvdb", "imdb"} {
		if !set[want] {
			t.Errorf("badge %q missing from %v", want, keysSorted(set))
		}
	}
	if set["plex"] {
		t.Error("providerLinks must not add a plex badge: that needs a server lookup")
	}
	if l.Anilist != "https://anilist.co/anime/42" || l.Tmdb != "https://www.themoviedb.org/tv/100" ||
		l.Tvdb != "https://thetvdb.com/dereferrer/series/200" || l.Imdb != "https://www.imdb.com/title/tt300" {
		t.Errorf("links = %+v", l)
	}
}

// rankRecommendations is the whole recommender: everything else around it is
// plumbing, so the weighting, the evidence list and the exclusions are checked
// here rather than through a live AniList response.
func TestRankRecommendations(t *testing.T) {
	rec := func(id, rating int, title string) anilist.Recommendation {
		var m anilist.Media
		m.ID, m.Title.Romaji = id, title
		return anilist.Recommendation{Rating: rating, Media: m}
	}
	sources := []recSource{
		{ID: 1, Title: "Loved", Weight: 2.0},
		{ID: 2, Title: "Liked", Weight: 1.0},
	}
	recs := map[int][]anilist.Recommendation{
		1: {rec(10, 50, "Broad"), rec(11, 90, "Strong"), rec(99, 40, "Seen")},
		2: {rec(10, 50, "Broad"), rec(12, -80, "Downvoted")},
	}
	got := rankRecommendations(sources, recs, map[int]bool{99: true})

	if len(got) != 2 {
		t.Fatalf("want 2 candidates, got %d: %+v", len(got), got)
	}
	// Strong: 90*2.0 = 180. Broad: 50*2.0 + 50*1.0 = 150.
	if got[0].Media.ID != 11 || got[1].Media.ID != 10 {
		t.Fatalf("wrong order: %d then %d", got[0].Media.ID, got[1].Media.ID)
	}
	if got[0].Score != 180 || got[1].Score != 150 {
		t.Fatalf("scores %v / %v", got[0].Score, got[1].Score)
	}
	// evidence names the sources, heaviest contribution first
	if len(got[1].Sources) != 2 || got[1].Sources[0] != "Loved" || got[1].Sources[1] != "Liked" {
		t.Fatalf("evidence %v", got[1].Sources)
	}
	for _, c := range got {
		if c.Media.ID == 99 {
			t.Fatal("a title already on the user's list was recommended")
		}
		if c.Media.ID == 12 {
			t.Fatal("a downvoted edge became a recommendation")
		}
	}
}

func TestRankRecommendationsCapsEvidenceAndBreaksTiesStably(t *testing.T) {
	var sources []recSource
	recs := map[int][]anilist.Recommendation{}
	for i := 1; i <= 4; i++ {
		sources = append(sources, recSource{ID: i, Title: fmt.Sprintf("src%d", i), Weight: 1.0})
		var a, b anilist.Media
		a.ID, b.ID = 100, 200
		recs[i] = []anilist.Recommendation{{Rating: 10, Media: a}, {Rating: 10, Media: b}}
	}
	got := rankRecommendations(sources, recs, nil)
	if len(got) != 2 {
		t.Fatalf("want 2, got %d", len(got))
	}
	if len(got[0].Sources) != 3 {
		t.Fatalf("evidence should stop at three, got %v", got[0].Sources)
	}
	// equal scores: the lower media id goes first, every time
	if got[0].Media.ID != 100 || got[1].Media.ID != 200 {
		t.Fatalf("tie broken unstably: %d then %d", got[0].Media.ID, got[1].Media.ID)
	}
}

func TestSourceWeight(t *testing.T) {
	cases := []struct {
		name  string
		entry anilist.ListEntry
		want  float64
	}{
		{"unrated counts once", anilist.ListEntry{Status: "COMPLETED"}, 1.0},
		{"a perfect score counts double", anilist.ListEntry{Status: "COMPLETED", Score: 100}, 2.0},
		{"a bad score still counts a little", anilist.ListEntry{Status: "COMPLETED", Score: 10}, 0.65},
		{"a rewatch counts more", anilist.ListEntry{Status: "REPEATING"}, 1.25},
	}
	for _, c := range cases {
		if got := sourceWeight(c.entry); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
