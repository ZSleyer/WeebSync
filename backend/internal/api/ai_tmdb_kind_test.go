package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/tmdb"
)

// The model picks the source of a card ("tmdb:<kind>"), and a page it read
// can steer it. The kind becomes the TMDB request path and the shared cache
// key, so only tv and movie may pass; anything else asks TMDB nothing.
func TestAiMediaTmdbKindIsWhitelisted(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	var hits atomic.Int32
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(`{"id":1,"name":"Frieren"}`))
	}))
	defer fake.Close()
	t.Setenv("TMDB_API_KEY", "k")
	s.Tmdb = tmdb.New(s.DB)
	s.Tmdb.BaseURL = fake.URL
	s.Tmdb.HTTP = fake.Client()

	for _, bad := range []string{"tmdb:person", "tmdb:", "tmdb:account", "tmdb:../tv", "tmdb:TV"} {
		if m := s.aiMedia(context.Background(), bad, 1); m != nil {
			t.Errorf("%q gave a card", bad)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests reached TMDB for invalid kinds", n)
	}
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE key LIKE 'tmdb:media:%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cache rows for invalid kinds: %d (%v)", n, err)
	}
	if m := s.aiMedia(context.Background(), "tmdb:tv", 1); m == nil || hits.Load() == 0 {
		t.Errorf("tmdb:tv did not reach TMDB")
	}
}
