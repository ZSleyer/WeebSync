package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/tmdb"
)

// source=tmdb:<kind> reaches the TMDB request path and the cache key, so only
// the two real kinds may pass; anything else is the "unknown source" 400
// without a request to TMDB.
func TestMediaExtrasTmdbKindIsWhitelisted(t *testing.T) {
	mux, s, _, userC, _, _ := setupUsersTest(t)
	var hits atomic.Int32
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{"results":[],"cast":[]}`))
	}))
	defer fake.Close()
	t.Setenv("TMDB_API_KEY", "k")
	s.Tmdb = tmdb.New(s.DB)
	s.Tmdb.BaseURL = fake.URL
	s.Tmdb.HTTP = fake.Client()

	for _, bad := range []string{"tmdb:account", "tmdb:", "tmdb:foo", "tmdb:../tv/1/credits?", "tmdb:TV"} {
		rec := doReq(mux, "GET", "/api/media/extras?id=1&source="+url.QueryEscape(bad), "", userC)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: %d, want 400", bad, rec.Code)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached TMDB for invalid kinds", n)
	}
	for _, ok := range []string{"tmdb:tv", "tmdb:movie"} {
		rec := doReq(mux, "GET", "/api/media/extras?id=1&source="+url.QueryEscape(ok), "", userC)
		if rec.Code != http.StatusOK {
			t.Errorf("%q: %d %s, want 200", ok, rec.Code, rec.Body)
		}
	}
}

func TestTmdbValidKind(t *testing.T) {
	for kind, want := range map[string]bool{"tv": true, "movie": true, "": false, "account": false, "TV": false, "tv/1": false} {
		if got := tmdb.ValidKind(kind); got != want {
			t.Errorf("ValidKind(%q) = %v, want %v", kind, got, want)
		}
	}
}
