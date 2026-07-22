package api

import (
	"encoding/json"
	"testing"
)

// TestParseFribb covers the two shapes the dataset uses: a TV entry
// (themoviedb_id {"tv": N} scalar, season {tvdb,tmdb}) and a MOVIE entry
// (themoviedb_id {"movie": [N]} list, no season).
func TestParseFribb(t *testing.T) {
	tv := fribbEntry{AnilistID: 290, TVDBID: 72025,
		TMDB: json.RawMessage(`{"tv":26209}`), IMDB: json.RawMessage(`["tt0286390"]`)}
	tv.Season.TVDB, tv.Season.TMDB = 1, 1
	got := parseFribb(tv)
	if got.tvdbID != 72025 || got.tvdbSeason != 1 || got.tmdbID != 26209 || got.tmdbKind != "tv" || got.imdbID != "tt0286390" {
		t.Fatalf("tv parse wrong: %+v", got)
	}

	mv := fribbEntry{AnilistID: 164,
		TMDB: json.RawMessage(`{"movie":[128]}`), IMDB: json.RawMessage(`["tt0119698"]`)}
	got = parseFribb(mv)
	if got.tmdbID != 128 || got.tmdbKind != "movie" || got.tvdbID != 0 || got.imdbID != "tt0119698" {
		t.Fatalf("movie parse wrong: %+v", got)
	}
}
