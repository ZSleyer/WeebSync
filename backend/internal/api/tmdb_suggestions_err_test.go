package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

func tmdbSuggestionsFixture(t *testing.T, h http.HandlerFunc) (mux *http.ServeMux, s *Server, c *http.Cookie, userID int64) {
	t.Helper()
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, c, _, userID = setupUsersTest(t)
	fake := httptest.NewServer(h)
	t.Cleanup(fake.Close)
	t.Setenv("TMDB_API_KEY", "k")
	s.Tmdb = tmdb.New(s.DB)
	s.Tmdb.BaseURL = fake.URL
	s.Tmdb.HTTP = fake.Client()
	enc, err := secret.Encrypt("sess")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO tmdb_accounts (user_id, tmdb_account_id, session_enc) VALUES (?, 77, ?)`, userID, enc); err != nil {
		t.Fatal(err)
	}
	return mux, s, c, userID
}

func getTmdbSuggestions(t *testing.T, mux *http.ServeMux, c *http.Cookie) tmdbSuggestionsResponse {
	t.Helper()
	rec := doReq(mux, "GET", "/api/tmdb/suggestions?force=1", "", c)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var out tmdbSuggestionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A session TMDB no longer accepts (the app authorisation was revoked) must
// show up as "link again", not as an endlessly empty watchlist.
func TestTmdbSuggestionsRevokedSession(t *testing.T) {
	mux, _, c, _ := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/watchlist/") {
			http.Error(w, `{"status_code":3}`, http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"results":[]}`))
	})
	out := getTmdbSuggestions(t, mux, c)
	if out.Connected || out.WatchlistError != "unauthorized" {
		t.Fatalf("connected=%v watchlistError=%q, want a revoked session reported", out.Connected, out.WatchlistError)
	}
}

// Other watchlist and trending failures are reported too, not turned into an
// empty list; the account stays connected.
func TestTmdbSuggestionsProviderFailureIsReported(t *testing.T) {
	mux, _, c, _ := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	})
	out := getTmdbSuggestions(t, mux, c)
	if !out.Connected || out.WatchlistError != "unavailable" || out.TrendingError != "unavailable" {
		t.Fatalf("%+v, want connected with both errors reported", out)
	}
}

// A cached watchlist that no longer parses is a miss, not an empty answer
// held for an hour.
func TestTmdbSuggestionsCorruptCacheIsAMiss(t *testing.T) {
	var watchlistCalls atomic.Int32
	mux, s, c, _ := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/watchlist/") {
			watchlistCalls.Add(1)
		}
		w.Write([]byte(`{"page":1,"total_pages":1,"results":[]}`))
	})
	s.cacheSet("tmdb:watchlist:77:tv", "{not json")
	s.cacheSet("tmdb:watchlist:77:movie", "{not json")
	rec := doReq(mux, "GET", "/api/tmdb/suggestions", "", c) // no force: the cache decides
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if n := watchlistCalls.Load(); n != 2 {
		t.Fatalf("%d watchlist fetches, want 2 (corrupt cache refetched)", n)
	}
	if p, _ := s.cacheGet("tmdb:watchlist:77:tv", 3600e9); strings.HasPrefix(p, "{not") {
		t.Error("corrupt cache entry was not replaced")
	}
}

// "No account" is the quiet case; a broken account row is reported.
func TestTmdbSuggestionsUnreadableSession(t *testing.T) {
	mux, s, c, userID := tmdbSuggestionsFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	})
	s.DB.Exec(`UPDATE tmdb_accounts SET session_enc = x'00' WHERE user_id = ?`, userID)
	out := getTmdbSuggestions(t, mux, c)
	if out.WatchlistError == "" {
		t.Fatalf("%+v, want the unreadable session reported", out)
	}
	s.DB.Exec(`DELETE FROM tmdb_accounts WHERE user_id = ?`, userID)
	if out := getTmdbSuggestions(t, mux, c); out.Connected || out.WatchlistError != "" {
		t.Fatalf("%+v, want plain not-connected", out)
	}
}
