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

	// a chart that fails does, and keeps what the last build had from it
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'tmdb:trending:movie'`); err != nil {
		t.Fatal(err)
	}
	dt.s.buildTVTrending(context.Background())
	b, _, _ = dt.s.tvTrendingBlob()
	if !b.Partial || len(b.Items) != 4 {
		t.Errorf("chart failure: partial=%v items=%d, want true and 4", b.Partial, len(b.Items))
	}
	kept := false
	for _, e := range b.Items {
		kept = kept || (e.Source == "movie" && e.TmdbID == 700)
	}
	if !kept {
		t.Errorf("the failed movie chart dropped the last build's movie: %+v", b.Items)
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

// With every provider down the last entries keep serving, and the attempt is
// stamped: the next one waits tvTrendingRetry instead of running on every
// sweep tick and every poll.
func TestTVTrendingEmptyBuildKeepsBlob(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'trending:anime' OR key LIKE 'tmdb:trending:%'`); err != nil {
		t.Fatal(err)
	}
	if _, err := dt.s.DB.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', '-9 hours') WHERE key = ?`, tvTrendingKey); err != nil {
		t.Fatal(err)
	}
	dt.s.Anilist.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.Tmdb.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.buildTVTrending(context.Background())
	if b, _, ok := dt.s.tvTrendingBlob(); !ok || len(b.Items) != 4 || !b.Partial {
		t.Errorf("blob after an empty build = %+v", b)
	}
	if dt.s.tvTrendingStale() {
		t.Error("a failed build left the blob stale: every sweep tick and poll would ask the providers again")
	}
}

// Rows kept from a failed TMDB chart go through the anime dedupe like fresh
// ones, and a kept anime does not collect its German title once per retry.
func TestTVTrendingKeptRowsDedupe(t *testing.T) {
	dt := newDeviceTest(t)
	dt.seedTrendingCaches()
	full, ok := dt.s.cacheGet("trending:anime", time.Hour)
	if !ok {
		t.Fatal("no seeded anime chart")
	}
	// build 1: only the obscure anime, so TMDB tv 500 comes in as a tv row
	dt.s.cacheSet("trending:anime", `[{"id":101,"title":{"romaji":"Obscure Anime"},"seasonYear":2024}]`)
	dt.s.buildTVTrending(context.Background())
	// build 2: Frieren (tmdb tv 500) trends as an anime, the TMDB tv chart is down
	dt.s.cacheSet("trending:anime", full)
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'tmdb:trending:tv'`); err != nil {
		t.Fatal(err)
	}
	dt.s.Tmdb.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.buildTVTrending(context.Background())
	b, _, _ := dt.s.tvTrendingBlob()
	n := 0
	for _, e := range b.Items {
		if e.TmdbID == 500 {
			n++
		}
	}
	if n != 1 {
		t.Errorf("tmdb tv 500 listed %d times, want once: %+v", n, b.Items)
	}

	// AniList down twice: the kept Frieren keeps one copy of its German title
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'trending:anime'`); err != nil {
		t.Fatal(err)
	}
	dt.s.Anilist.HTTP = &http.Client{Transport: downTransport{}}
	titles := func() int {
		b, _, _ := dt.s.tvTrendingBlob()
		for _, e := range b.Items {
			if e.AnilistID == 100 {
				return len(e.Titles)
			}
		}
		t.Fatal("Frieren dropped")
		return 0
	}
	dt.s.buildTVTrending(context.Background())
	first := titles()
	dt.s.buildTVTrending(context.Background())
	if got := titles(); got != first {
		t.Errorf("titles grew across retries: %d then %d", first, got)
	}
}

// The first build failing with nothing to keep still writes an (empty,
// partial) blob, so the providers are not asked again before tvTrendingRetry.
func TestTVTrendingFirstBuildFailsWaits(t *testing.T) {
	dt := newDeviceTest(t)
	if _, err := dt.s.DB.Exec(`DELETE FROM anilist_cache`); err != nil {
		t.Fatal(err)
	}
	dt.s.Anilist.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.Tmdb.HTTP = &http.Client{Transport: downTransport{}}
	dt.s.buildTVTrending(context.Background())
	b, _, ok := dt.s.tvTrendingBlob()
	if !ok || len(b.Items) != 0 || !b.Partial {
		t.Fatalf("blob after a failed first build = %+v, ok=%v", b, ok)
	}
	if dt.s.tvTrendingStale() {
		t.Error("a failed first build is retried at once")
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
