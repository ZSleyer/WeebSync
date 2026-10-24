package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// offlineAnilist gives s an AniList client that never leaves the process: the
// build asks it for trending and recommendations, which are not under test.
func offlineAnilist(s *Server) {
	s.Anilist = anilist.New(s.DB)
	s.Anilist.HTTP = &http.Client{Transport: focusRT(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("offline")
	})}
}

// getSuggestions reads /api/suggestions as the page does.
func getSuggestions(t *testing.T, mux *http.ServeMux, c *http.Cookie) SuggestionsResponse {
	t.Helper()
	rec := doReq(mux, "GET", "/api/suggestions", "", c)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var out SuggestionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The Suggestions page reads /api/suggestions, not /api/tmdb/suggestions: a
// revoked TMDB link showed there as a quietly empty watchlist. The built blob
// carries the TMDB errors so the page can say "link TMDB again".
func TestSuggestionsCarryTmdbErrors(t *testing.T) {
	mux, s, c, userID := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/watchlist/") {
			http.Error(w, `{"status_code":3}`, http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"results":[]}`))
	})
	offlineAnilist(s)
	s.buildUserSuggestions(context.Background(), userID)
	out := getSuggestions(t, mux, c)
	if out.WatchlistError != "unauthorized" || out.TrendingError != "" {
		t.Fatalf("watchlistError=%q trendingError=%q, want the revoked link reported", out.WatchlistError, out.TrendingError)
	}
}

func TestSuggestionsCarryTmdbOutage(t *testing.T) {
	mux, s, c, userID := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	})
	offlineAnilist(s)
	s.buildUserSuggestions(context.Background(), userID)
	out := getSuggestions(t, mux, c)
	if out.WatchlistError != "unavailable" || out.TrendingError != "unavailable" {
		t.Fatalf("watchlistError=%q trendingError=%q, want both reported unavailable", out.WatchlistError, out.TrendingError)
	}
}
