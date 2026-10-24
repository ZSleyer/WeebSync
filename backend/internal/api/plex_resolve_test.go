package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// seedGuidIndex puts a guid index straight into the cache table, so the
// resolution can be tested without a Plex server behind it.
func seedGuidIndex(t *testing.T, s *Server, payload string) {
	t.Helper()
	s.cacheSet("plex:guididx:v5", payload)
}

// A ratingKey is a row id in Plex's metadata db, not an identity: rebuilding an
// item re-issues it. A stored row must therefore never outrank what the library
// says today - on the reference server 9 of 255 shows had been renumbered.
func TestPlexRatingKeyResolvePrefersTheLiveGuid(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	// the stored address is stale: Plex has since re-added the show
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',305089,1), ('plex',58605,1)`)
	seedGuidIndex(t, s, `{"rezero":{"tvdb":305089,"ratingKey":"62755"}}`)

	if got := s.plexRatingKeyResolve("tvdb:305089"); got != "62755" {
		t.Errorf("resolve = %q, want the live 62755 rather than the stored 58605", got)
	}
	// and the contradicted row is gone, so it cannot mislead the next caller
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'plex' AND media_id = 58605`).Scan(&n)
	if n != 0 {
		t.Error("the stored ratingKey the library contradicts is still there")
	}
}

// The automatic passes correct each other; a person's choice they do not touch.
func TestPlexRatingKeyResolveKeepsAManualLink(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id, manual) VALUES ('tvdb',305089,1,0), ('plex',58605,1,1)`)
	seedGuidIndex(t, s, `{"rezero":{"tvdb":305089,"ratingKey":"62755"}}`)

	if got := s.plexRatingKeyResolve("tvdb:305089"); got != "58605" {
		t.Errorf("resolve = %q, want the hand-picked 58605", got)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'plex' AND media_id = 58605`).Scan(&n)
	if n != 1 {
		t.Error("the hand-picked link was deleted by the self-healing pass")
	}
}

// Plex unreachable means an empty index, and an empty index must not erase what
// we already knew - a stale address still beats no address.
func TestPlexRatingKeyResolveFallsBackWhenPlexIsSilent(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
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
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'yomi no tsugai','Yomi no Tsugai')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',171018,1), ('tvdb',452711,1)`)
	// Plex knows the show under a German title and has no plex row on the series
	seedGuidIndex(t, s, `{"dasbandderunterwelt":{"tvdb":452711,"ratingKey":"71812"}}`)

	if got := s.plexRatingKeyResolve("tvdb:452711"); got != "71812" {
		t.Errorf("resolve = %q, want 71812", got)
	}
}

// One show can sit in two libraries ("Anime" and "Anime 4K"), so one id finds
// two ratingKeys. The pick used to follow map order: the resolve then saw the
// stored key contradicted at random and deleted it.
func TestPlexRatingKeyResolveIsStableWithTwoEntries(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',305089,1), ('plex',200,1)`)
	seedGuidIndex(t, s, `{"rezero":{"tvdb":305089,"ratingKey":"200"},"rezero4k":{"tvdb":305089,"ratingKey":"100"},
		"tvdb:305089":{"tvdb":305089,"ratingKey":"200"}}`)

	for range 30 {
		if got := s.plexRatingKeyResolve("tvdb:305089"); got != "200" {
			t.Fatalf("resolve = %q, want the stored 200, which Plex still lists", got)
		}
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'plex' AND media_id = 200`).Scan(&n)
	if n != 1 {
		t.Fatal("the stored ratingKey was deleted although Plex still lists it for the show")
	}

	idx := s.plexGuidIndexNoWait()
	for range 30 {
		if got := guidRatingKey(idx, "tvdb:305089"); got != "100" {
			t.Fatalf("guidRatingKey = %q, want the lowest key 100 every time", got)
		}
	}
}

// A film and a series can share a TMDB number, and a show_key ("tmdb:42")
// does not say which: the folder's kind does. A film folder used to land on
// the series entry, and a series could take the film's ids.
func TestGuidForShowKeyTakesTheFoldersKind(t *testing.T) {
	idx := map[string]plexGuid{
		"movie:a": {TMDB: 42, RatingKey: "1", Movie: true},
		"b":       {TMDB: 42, RatingKey: "9"},
		"movie:c": {TMDB: 77, RatingKey: "5", Movie: true},
	}
	for range 30 {
		if g, _ := guidForShowKey(idx, "tmdb:42", false); g.RatingKey != "9" {
			t.Fatalf("series: %q, want 9", g.RatingKey)
		}
		if g, _ := guidForShowKey(idx, "tmdb:42", true); g.RatingKey != "1" {
			t.Fatalf("film: %q, want 1", g.RatingKey)
		}
	}
	// a film is no answer for a series of the same number, nor the reverse
	if g, ok := guidForShowKey(idx, "tmdb:77", false); ok {
		t.Errorf("a series took the film %q", g.RatingKey)
	}
	if g, ok := guidForShowKey(map[string]plexGuid{"b": {TMDB: 42, RatingKey: "9"}}, "tmdb:42", true); ok {
		t.Errorf("a film took the series %q", g.RatingKey)
	}
}

// The badge link only has the show_key and the refs: a tmdb key the refs
// carry as a film id (and not as a series id) names the film.
func TestShowKeyIsFilm(t *testing.T) {
	film := []providerRef{{"tmdb:movie", 42}, {"imdb", 7}}
	both := []providerRef{{"tmdb:movie", 42}, {"tmdb:tv", 42}}
	series := []providerRef{{"tmdb:tv", 42}}
	for _, tc := range []struct {
		refs []providerRef
		key  string
		want bool
	}{
		{film, "tmdb:42", true},
		{both, "tmdb:42", false},
		{series, "tmdb:42", false},
		{film, "tvdb:42", false},
		{film, "tmdb:43", false},
		{nil, "", false},
	} {
		if got := showKeyIsFilm(tc.refs, tc.key); got != tc.want {
			t.Errorf("showKeyIsFilm(%v, %q) = %v, want %v", tc.refs, tc.key, got, tc.want)
		}
	}
}

// The deep link and stream selection of a film folder resolve to the film,
// through its tmdb:movie row as much as through the live index.
func TestPlexRatingKeyResolveTakesTheFoldersKind(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'fargo','Fargo'), (2,'fargo film','Fargo')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES
		('tmdb:tv',42,1), ('plex',9,1), ('tmdb:movie',42,2), ('plex',1,2)`)
	seedGuidIndex(t, s, `{"movie:fargo":{"tmdb":42,"ratingKey":"1","movie":true},"fargo":{"tmdb":42,"ratingKey":"9"}}`)

	if got := s.plexRatingKeyResolveKind("tmdb:42", true); got != "1" {
		t.Errorf("film = %q, want 1", got)
	}
	if got := s.plexRatingKeyResolveKind("tmdb:42", false); got != "9" {
		t.Errorf("series = %q, want 9", got)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'plex'`).Scan(&n)
	if n != 2 {
		t.Errorf("%d plex rows left, want both: neither contradicts its own kind", n)
	}
	// with Plex silent, the film's stored row answers
	seedGuidIndex(t, s, `{}`)
	if got := s.plexRatingKeyResolveKind("tmdb:42", true); got != "1" {
		t.Errorf("stored film = %q, want 1", got)
	}
}
