package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// seedGuidIndex puts a guid index straight into the cache table, so the
// resolution can be tested without a Plex server behind it.
func seedGuidIndex(t *testing.T, s *Server, payload string) {
	t.Helper()
	s.cacheSet("plex:guididx:v2", payload)
}

// A ratingKey is a row id in Plex's metadata db, not an identity: rebuilding an
// item re-issues it. A stored row must therefore never outrank what the library
// says today - on the reference server 9 of 255 shows had been renumbered.
func TestPlexRatingKeyResolvePrefersTheLiveGuid(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	// the stored address is stale: Plex has since re-added the show
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',305089,1), ('plex',58605,1)`)
	seedGuidIndex(t, s, `{"rezero":{"tvdb":305089,"ratingKey":"62755"}}`)

	if got := s.plexRatingKeyResolve("tvdb:305089"); got != "62755" {
		t.Errorf("resolve = %q, want the live 62755 rather than the stored 58605", got)
	}
}

// Plex unreachable means an empty index, and an empty index must not erase what
// we already knew - a stale address still beats no address.
func TestPlexRatingKeyResolveFallsBackWhenPlexIsSilent(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',305089,1), ('plex',58605,1)`)
	seedGuidIndex(t, s, `{}`)

	if got := s.plexRatingKeyResolve("tvdb:305089"); got != "58605" {
		t.Errorf("resolve = %q, want the stored 58605", got)
	}
	if got := s.plexRatingKeyResolve(""); got != "" {
		t.Errorf("resolve(%q) = %q, want empty", "", got)
	}
}

// The point of the whole exercise: the show is found through the ids the series
// carries, so a Plex title in another language is no obstacle. "Yomi no Tsugai"
// is filed as "Das Band der Unterwelt" on the reference server.
func TestPlexRatingKeyResolveNeedsNoTitle(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'yomi no tsugai','Yomi no Tsugai')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',171018,1), ('tvdb',452711,1)`)
	// Plex knows the show under a German title and has no plex row on the series
	seedGuidIndex(t, s, `{"dasbandderunterwelt":{"tvdb":452711,"ratingKey":"71812"}}`)

	if got := s.plexRatingKeyResolve("tvdb:452711"); got != "71812" {
		t.Errorf("resolve = %q, want 71812", got)
	}
}
