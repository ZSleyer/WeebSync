package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// A film library's agent gives Plex an IMDb and a TMDB id but no TVDB one. The
// remote id lookup turns that into TVDB's film, so a folder in a TVDB-marked
// tree still takes Plex's word over a title search; a series of the same name
// does not take the film.
func TestPlexFilmReachesTvdbThroughItsImdbID(t *testing.T) {
	d := dbtest.Open(t)
	db.SetSetting(d, "tvdb_api_key", "test-key")
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d), Tvdb: tvdb.New(d)})
	// keyed as the index keys it: the folded title
	seedGuidIndex(t, s, `{"yor name":{"tmdb":372058,"imdb":5311514,"year":2016,"ratingKey":"7","movie":true}}`)
	// what /search/remoteid answered, already cached
	s.cacheSet("tvdb:remoteid:tt5311514", `{"Series":0,"Movie":197}`)

	if id, ok := s.matchLocalByPlexID("/films/Your Name (2016)", tvdbMovieSource); !ok || id != 197 {
		t.Fatalf("film: %d %v, want TVDB film 197", id, ok)
	}
	if id, ok := s.matchLocalByPlexID("/shows/Your Name (2016)", "tvdb"); ok {
		t.Fatalf("a series folder took the film: %d", id)
	}
}

// A TMDB number can name a series and an unrelated film at once: the lookup
// picks the kind the folder is.
func TestTvdbFromRemotePicksTheKind(t *testing.T) {
	d := dbtest.Open(t)
	db.SetSetting(d, "tvdb_api_key", "test-key")
	s := testServer(t, &Server{DB: d, Tvdb: tvdb.New(d)})
	s.cacheSet("tvdb:remoteid:131378", `{"Series":408850,"Movie":193127}`)
	if got := s.tvdbFromRemote(plexGuid{TMDB: 131378}, false); got != 408850 {
		t.Errorf("series: %d", got)
	}
	if got := s.tvdbFromRemote(plexGuid{TMDB: 131378, Movie: true}, true); got != 193127 {
		t.Errorf("film: %d", got)
	}
}
