package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func mediaFmt(f string) anilist.Media { return anilist.Media{Format: f} }

func TestCategorize(t *testing.T) {
	cases := []struct {
		providers []string
		format    string
		source    string
		want      string
	}{
		{[]string{"anilist", "tvdb"}, "TV", "anilist", "anime-tv"},
		{[]string{"anilist"}, "MOVIE", "anilist", "anime-movie"},
		{[]string{"tmdb"}, "TV", "tmdb:tv", "tv"},
		{[]string{"tmdb"}, "MOVIE", "tmdb:movie", "movie"},
		{[]string{"tvdb"}, "TV", "tvdb", "anime-tv"},
		{[]string{"anilist"}, "OVA", "anilist", "anime-tv"}, // non-movie anime -> tv
		{[]string{"tmdb", "plex"}, "TV", "tmdb:tv", "tv"},   // plex badge doesn't make it anime
	}
	for _, c := range cases {
		if got := categorize(c.providers, mediaFmt(c.format), c.source); got != c.want {
			t.Errorf("categorize(%v,%s,%s)=%s want %s", c.providers, c.format, c.source, got, c.want)
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
