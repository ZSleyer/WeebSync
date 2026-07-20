package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

func TestDefaultSectionSource(t *testing.T) {
	cases := []struct {
		name string
		sec  plex.Section
		want string
	}{
		// what Plex reports on the real instance
		{"anime library ordered by tvdb", plex.Section{Type: "show", Title: "Animeserien", Provider: "tvdb"}, sourceAnilistTvdb},
		{"show library ordered by tmdb", plex.Section{Type: "show", Title: "Serien", Provider: "tmdb"}, "tmdb"},
		{"movie library", plex.Section{Type: "movie", Title: "Filme", Provider: "tmdb"}, "tmdb"},
		// anime keeps AniList even when Plex is on TMDB
		{"anime library ordered by tmdb", plex.Section{Type: "show", Title: "Animeserien", Provider: "tmdb"}, "anilist"},
		// anime films stay on AniList, but never on the combined source: the
		// aired mapping is a series concern
		{"anime movies", plex.Section{Type: "movie", Title: "Animefilme", Provider: "tvdb"}, "anilist"},
		// legacy agent, no ordering: Sections() fills Provider from the agent
		{"legacy tvdb agent", plex.Section{Type: "show", Title: "Serien", Provider: "tvdb"}, "tvdb"},
		// nothing to go on
		{"unknown", plex.Section{Type: "show", Title: "Serien"}, "tmdb"},
	}
	for _, c := range cases {
		if got := DefaultSectionSource(c.sec); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
