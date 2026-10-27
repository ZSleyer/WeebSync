package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// kind is compared exactly: a list of kinds is not a kind.
func TestTVTrendingKindExact(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	tok := dt.link(dt.alice, "A")
	for _, k := range []string{"anime%7Ctv", "anime,tv", "ANIME", "tv%20", "all%7C"} {
		if rec := dt.do("GET", "/api/tv/trending?kind="+k, "", nil, tok, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("kind=%s: %d, want 400", k, rec.Code)
		}
	}
}

// A TMDB id that is gone (the lookup fails) keeps the AniList text and does
// not make the blob partial; a failed chart does.
func TestTVTrendingPartialOnlyForCharts(t *testing.T) {
	dt := newDeviceTest(t)
	dt.seedTrendingCaches()
	dt.s.Tmdb.HTTP = &http.Client{Transport: downTransport{}}
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key IN ('tmdb:media:tv:500', 'tmdb:backdrop:tv:500')`); err != nil {
		t.Fatal(err)
	}
	dt.s.buildTVTrending(context.Background())
	b, _, ok := dt.s.tvTrendingBlob()
	if !ok || len(b.Items) != 4 {
		t.Fatalf("blob = %+v", b)
	}
	if b.Partial {
		t.Error("a failed per-item lookup made the blob partial")
	}
	if b.Items[0].Title != "Sousou no Frieren" || b.Items[0].Overview != "English text" {
		t.Errorf("the AniList text should stay: %+v", b.Items[0])
	}

	// a chart that fails does
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'tmdb:trending:movie'`); err != nil {
		t.Fatal(err)
	}
	dt.s.buildTVTrending(context.Background())
	b, _, _ = dt.s.tvTrendingBlob()
	if !b.Partial || len(b.Items) != 3 {
		t.Errorf("chart failure: partial=%v items=%d, want true and 3", b.Partial, len(b.Items))
	}
}

// A complete blob is rebuilt after 8 hours, a partial one after 30 minutes.
func TestTVTrendingStaleTiming(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	age := func(sql string) {
		t.Helper()
		if _, err := dt.s.DB.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', ?) WHERE key = ?`, sql, tvTrendingKey); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		ago   string
		stale bool
	}{{"-40 minutes", false}, {"-7 hours", false}, {"-9 hours", true}} {
		age(c.ago)
		if got := dt.s.tvTrendingStale(); got != c.stale {
			t.Errorf("complete blob %s old: stale = %v, want %v", c.ago, got, c.stale)
		}
	}
	b, _, _ := dt.s.tvTrendingBlob()
	b.Partial = true
	dt.s.cacheSet(tvTrendingKey, mustJSON(t, b))
	for _, c := range []struct {
		ago   string
		stale bool
	}{{"-10 minutes", false}, {"-40 minutes", true}} {
		age(c.ago)
		if got := dt.s.tvTrendingStale(); got != c.stale {
			t.Errorf("partial blob %s old: stale = %v, want %v", c.ago, got, c.stale)
		}
	}
}

// A build that yields nothing leaves the previous blob in place.
func TestTVTrendingEmptyBuildKeepsBlob(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'trending:anime' OR key LIKE 'tmdb:trending:%'`); err != nil {
		t.Fatal(err)
	}
	dt.s.Anilist.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.Tmdb.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.buildTVTrending(context.Background())
	if b, _, ok := dt.s.tvTrendingBlob(); !ok || len(b.Items) != 4 || b.Partial {
		t.Errorf("blob after an empty build = %+v", b)
	}
}

// An anime folder matched through TVDB is the user's watch too, and the
// German title counts for the library check.
func TestTVTrendingTvdbWatchAndGermanTitle(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	dt.seedTVWatch(1, "Frieren", 9, nil, nil)
	if _, err := dt.s.DB.Exec(`UPDATE catalog_matches SET source = 'tvdb', media_id = 9`); err != nil {
		t.Fatal(err)
	}
	// the library only knows the German title the build took from TMDB
	dt.s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url','http://plex.invalid:32400'), ('plex_token','t')`)
	dt.s.cacheSet("plex:titleidx:v2", `{"frieren - jenseits des endes":"55"}`)
	dt.s.cacheSet("plex:guididx:v5", `{}`)
	alice := dt.link(dt.alice, "A")
	bob := dt.link(dt.bob, "B")
	a := dt.trending(alice, "")
	if a[0].WatchID == 0 || !a[0].InLibrary {
		t.Errorf("alice = %+v, want her tvdb-matched watch and the German title owned", a[0])
	}
	if b := dt.trending(bob, ""); b[0].WatchID != 0 {
		t.Errorf("bob = %+v", b[0])
	}
}

// With Plex configured and no cached index, a poll answers at once: it does
// not wait for Plex (the index is warmed behind it).
func TestTVTrendingPollNeverWaitsForPlex(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	release := make(chan struct{})
	plex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release // Plex hangs
	}))
	defer plex.Close()
	defer close(release)
	dt.s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url', ?), ('plex_token','t')`, plex.URL)
	alice := dt.link(dt.alice, "A")
	start := time.Now()
	if got := dt.trending(alice, ""); len(got) != 4 {
		t.Errorf("%d entries", len(got))
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("the poll took %s: it waited for Plex", d)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
