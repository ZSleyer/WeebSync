package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// ownMedia builds a media with the three titles the owned check looks at.
func ownMedia(id int, romaji, english, native string) anilist.Media {
	var m anilist.Media
	m.ID = id
	m.Title.Romaji = romaji
	m.Title.English = english
	m.Title.Native = native
	return m
}

// A title Plex holds must not come back as a discovery - by title for the
// AniList charts, and by TMDB id for the TMDB ones, where the two catalogues
// spell the same film differently often enough that titles alone miss it.
func TestPlexOwnedMatchesTitleAndTmdbID(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	// both indexes are read from the cache table, so the check runs without a
	// Plex server behind it
	s.cacheSet("plex:titleidx:v2", `{"sword art online":"11","ソードアート・オンライン":"11"}`)
	s.cacheSet("plex:guididx:v2", `{"thematrix":{"tmdb":603,"ratingKey":"42"}}`)
	// plexOwned needs a configured client to consult the indexes at all
	d.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url','http://plex.example.com:32400'), ('plex_token','t')`)

	owned := s.plexOwned()
	cases := []struct {
		name   string
		m      anilist.Media
		source string
		want   bool
	}{
		{"title, differing case and spacing", ownMedia(1, "Sword  Art   Online", "", ""), "anilist", true},
		{"english title", ownMedia(2, "Sao Progressive", "Sword Art Online", ""), "anilist", true},
		{"native title", ownMedia(3, "Nope", "", "ソードアート・オンライン"), "anilist", true},
		{"unknown title", ownMedia(4, "One Piece", "One Piece", ""), "anilist", false},
		{"tmdb id, title spelled otherwise in plex", ownMedia(603, "Matrix", "", ""), "tmdb:movie", true},
		{"tmdb id absent", ownMedia(999, "Matrix", "", ""), "tmdb:movie", false},
		// an AniList id must never be read as a TMDB id: 603 is The Matrix
		// there and something else entirely on AniList
		{"anilist id is not a tmdb id", ownMedia(603, "Some Anime", "", ""), "anilist", false},
	}
	for _, c := range cases {
		if got := owned(c.m, c.source); got != c.want {
			t.Errorf("%s: owned = %v, want %v", c.name, got, c.want)
		}
	}
}
