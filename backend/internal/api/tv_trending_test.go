package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

// noProvider fails the test for every provider request it sees.
type noProvider struct {
	t    *testing.T
	hits atomic.Int32
}

func (n *noProvider) RoundTrip(r *http.Request) (*http.Response, error) {
	n.hits.Add(1)
	n.t.Errorf("provider request in a TV poll: %s %s", r.Method, r.URL)
	return nil, http.ErrHandlerTimeout
}

// downTransport is a provider that cannot be reached.
type downTransport struct{}

func (downTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, http.ErrHandlerTimeout
}

// seedTrendingCaches fills the provider caches the build reads, so the build
// runs without a network:
//
//	anime  A1 (100) = TMDB tv 500, A2 (101) unmapped, A3 (102) = TMDB tv 500 (another cour)
//	tv     500 (the same series as A1), 600
//	movie  700
func (dt *deviceTest) seedTrendingCaches() *noProvider {
	dt.t.Helper()
	d := dt.s.DB
	if err := db.SetSetting(d, "tmdb_api_key", "test.jwt.token"); err != nil {
		dt.t.Fatal(err)
	}
	for k, v := range map[string]string{
		"trending:anime": `[
			{"id":100,"title":{"romaji":"Sousou no Frieren","english":"Frieren"},"coverImage":{"large":"https://img.example/100-l.jpg","extraLarge":"https://img.example/100-xl.jpg"},"seasonYear":2023,"description":"English <b>text</b>"},
			{"id":101,"title":{"romaji":"Obscure Anime"},"coverImage":{"large":"https://img.example/101-l.jpg"},"seasonYear":2024,"description":"Only English<br>here"},
			{"id":102,"title":{"romaji":"Frieren Part 2"},"coverImage":{"large":"https://img.example/102-l.jpg"},"seasonYear":2024}]`,
		"tmdb:trending:tv": `[
			{"id":500,"title":{"romaji":"Frieren (TMDB)"},"coverImage":{"large":"https://tmdb.example/500.jpg"},"bannerImage":"https://tmdb.example/b500.jpg"},
			{"id":600,"title":{"romaji":"Serie Sechshundert","english":"Series 600"},"coverImage":{"large":"https://tmdb.example/600.jpg","extraLarge":"https://tmdb.example/600-xl.jpg"},"bannerImage":"https://image.tmdb.org/t/p/w1280/b600.jpg","seasonYear":2025,"description":"Deutsche Beschreibung"}]`,
		"tmdb:trending:movie": `[
			{"id":700,"title":{"romaji":"Film Siebenhundert"},"coverImage":{"large":"https://tmdb.example/700.jpg"},"seasonYear":2026}]`,
		"tmdb:media:tv:500":    `{"id":500,"title":{"romaji":"Frieren - Jenseits des Endes"},"descriptions":{"de":"Deutscher Text","en":"English text"},"bannerImage":"https://image.tmdb.org/t/p/w1280/small.jpg"}`,
		"tmdb:backdrop:tv:500": `{"file_path":"/bd.jpg","width":1920}`,
	} {
		dt.s.cacheSet(k, v)
	}
	for _, q := range []string{
		`INSERT INTO anime_ids (anilist_id, tmdb_id, tmdb_kind, tvdb_id) VALUES (100, 500, 'tv', 9)`,
		`INSERT INTO anime_ids (anilist_id, tmdb_id, tmdb_kind) VALUES (102, 500, 'tv')`,
	} {
		if _, err := d.Exec(q); err != nil {
			dt.t.Fatal(err)
		}
	}
	np := &noProvider{t: dt.t}
	dt.s.Anilist.HTTP = &http.Client{Transport: np}
	dt.s.Tmdb.HTTP = &http.Client{Transport: np}
	return np
}

type tvTr struct {
	Source        string `json:"source"`
	AnilistID     int    `json:"anilistId"`
	TmdbID        int    `json:"tmdbId"`
	TvdbID        int    `json:"tvdbId"`
	Title         string `json:"title"`
	Overview      string `json:"overview"`
	Year          int    `json:"year"`
	PosterURL     string `json:"posterUrl"`
	BackdropURL   string `json:"backdropUrl"`
	InLibrary     bool   `json:"inLibrary"`
	PlexRatingKey string `json:"plexRatingKey"`
	WatchID       int64  `json:"watchId"`
	Rank          int    `json:"rank"`
}

func (dt *deviceTest) trending(tok, query string) []tvTr {
	dt.t.Helper()
	rec := dt.do("GET", "/api/tv/trending"+query, "", nil, tok, "")
	if rec.Code != http.StatusOK {
		dt.t.Fatalf("trending%s: %d %s", query, rec.Code, rec.Body)
	}
	var out []tvTr
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		dt.t.Fatal(err)
	}
	return out
}

// built runs the background build in the foreground and returns the provider guard.
func (dt *deviceTest) builtTrending() *noProvider {
	dt.t.Helper()
	np := dt.seedTrendingCaches()
	dt.s.buildTVTrending(context.Background())
	if n := np.hits.Load(); n != 0 {
		dt.t.Fatalf("the build asked a provider %d times; the caches were seeded", n)
	}
	return np
}

func TestTVTrendingAuth(t *testing.T) {
	dt := newDeviceTest(t)
	if rec := dt.do("GET", "/api/tv/trending", "", nil, "", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d", rec.Code)
	}
	if rec := dt.do("GET", "/api/tv/trending", "", dt.alice, "", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("cookie only: %d", rec.Code)
	}
	tok := dt.link(dt.alice, "A")
	// the first poll schedules a build; the provider is down for it
	dt.s.Anilist.HTTP = &http.Client{Transport: downTransport{}}
	rec := dt.do("GET", "/api/tv/trending", "", nil, tok, "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" && dt.s.tvTrendingStale() {
		t.Fatalf("valid token, no blob yet: %d %s, want 200 []", rec.Code, rec.Body)
	}
	if _, err := dt.s.DB.Exec(`DELETE FROM device_tokens`); err != nil {
		t.Fatal(err)
	}
	if rec := dt.do("GET", "/api/tv/trending", "", nil, tok, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked token: %d", rec.Code)
	}
}

// The build merges one series that several charts and cours name, prefers the
// German texts, interleaves the three sources, and a poll serves it.
func TestTVTrendingBuildAndMerge(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	tok := dt.link(dt.alice, "A")
	got := dt.trending(tok, "")
	// anime 100, tv 600, movie 700, anime 101; TMDB 500 and A3 (102) merged into the first
	if len(got) != 4 {
		t.Fatalf("trending = %+v, want 4 entries", got)
	}
	for i := range got {
		if got[i].Rank != i+1 {
			t.Errorf("entry %d rank = %d", i, got[i].Rank)
		}
	}
	if g := got[0]; g.Source != "anime" || g.AnilistID != 100 || g.TmdbID != 500 || g.TvdbID != 9 ||
		g.Title != "Frieren - Jenseits des Endes" || g.Overview != "Deutscher Text" || g.Year != 2023 ||
		g.PosterURL != "https://img.example/100-xl.jpg" || g.BackdropURL != "https://image.tmdb.org/t/p/w1280/bd.jpg" {
		t.Errorf("merged anime = %+v", g)
	}
	if g := got[1]; g.Source != "tv" || g.TmdbID != 600 || g.Title != "Serie Sechshundert" || g.Overview != "Deutsche Beschreibung" ||
		g.PosterURL != "https://tmdb.example/600-xl.jpg" || g.BackdropURL != "https://image.tmdb.org/t/p/w1280/b600.jpg" || g.Year != 2025 {
		t.Errorf("tv = %+v", g)
	}
	if g := got[2]; g.Source != "movie" || g.TmdbID != 700 {
		t.Errorf("movie = %+v", g)
	}
	// no German anywhere: the English text, markup stripped
	if g := got[3]; g.Source != "anime" || g.AnilistID != 101 || g.Overview != "Only English here" || g.TmdbID != 0 {
		t.Errorf("unmapped anime = %+v", g)
	}
	for _, g := range got {
		if g.AnilistID == 102 || (g.Source == "tv" && g.TmdbID == 500) {
			t.Errorf("duplicate listed: %+v", g)
		}
	}
}

// limit and kind narrow the answer; rank keeps its place in the whole list.
func TestTVTrendingLimitKind(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	tok := dt.link(dt.alice, "A")
	for _, c := range []struct {
		q    string
		want int
	}{{"?limit=2", 2}, {"?limit=0", 1}, {"?limit=x", 4}, {"?limit=500", 4}, {"?kind=anime", 2}, {"?kind=tv", 1}, {"?kind=movie", 1}, {"?kind=all", 4}, {"?kind=anime&limit=1", 1}} {
		if n := len(dt.trending(tok, c.q)); n != c.want {
			t.Errorf("trending%s: %d entries, want %d", c.q, n, c.want)
		}
	}
	if m := dt.trending(tok, "?kind=movie"); m[0].Rank != 3 {
		t.Errorf("movie rank = %d, want 3", m[0].Rank)
	}
	if rec := dt.do("GET", "/api/tv/trending?kind=manga", "", nil, tok, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown kind: %d", rec.Code)
	}
}

// inLibrary, plexRatingKey and watchId are the caller's own state.
func TestTVTrendingPerUser(t *testing.T) {
	dt := newDeviceTest(t)
	dt.builtTrending()
	// alice watches the unmapped anime; the media server holds the tv series
	// (by its TMDB id) and has the merged anime filed under its AniList id
	dt.seedTVWatch(1, "Obscure", 101, nil, nil)
	dt.seedTVWatch(2, "BobShow", 600, nil, nil)
	if _, err := dt.s.DB.Exec(`UPDATE catalog_matches SET source = 'tmdb:tv' WHERE media_id = 600`); err != nil {
		t.Fatal(err)
	}
	d := dt.s.DB
	d.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url','http://plex.example.com:32400'), ('plex_token','t')`)
	dt.s.cacheSet("plex:titleidx:v2", `{"film siebenhundert":"77"}`)
	dt.s.cacheSet("plex:guididx:v5", `{}`)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'frieren','Frieren')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',100,1), ('plex',4711,1)`)

	alice := dt.link(dt.alice, "A")
	bob := dt.link(dt.bob, "B")
	a, b := dt.trending(alice, ""), dt.trending(bob, "")
	if a[0].PlexRatingKey != "4711" || !a[0].InLibrary || a[0].WatchID != 0 {
		t.Errorf("alice, merged anime = %+v", a[0])
	}
	if a[2].WatchID != 0 || !a[2].InLibrary || a[2].PlexRatingKey != "" {
		t.Errorf("alice, movie (owned by title) = %+v", a[2])
	}
	if a[3].WatchID == 0 || a[3].InLibrary {
		t.Errorf("alice, watched anime = %+v", a[3])
	}
	if a[1].WatchID != 0 {
		t.Errorf("alice sees bob's watch: %+v", a[1])
	}
	if b[1].WatchID == 0 || b[3].WatchID != 0 {
		t.Errorf("bob = %+v", b)
	}
	if b[0].PlexRatingKey != "4711" {
		t.Errorf("the library is shared: %+v", b[0])
	}
}

// A poll never reaches a provider: without a blob it answers empty and the
// build runs in the background, with a stale one it serves the old list
// meanwhile. The transports of both providers fail the test on any request.
func TestTVTrendingPollIsCacheOnly(t *testing.T) {
	dt := newDeviceTest(t)
	np := dt.seedTrendingCaches()
	// the build is scheduled by the first poll and finds everything cached
	tok := dt.link(dt.alice, "A")
	dt.trending(tok, "") // empty or already built: the job is quick on cached data
	deadline := time.Now().Add(10 * time.Second)
	for dt.s.tvTrendingStale() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if dt.s.tvTrendingStale() {
		t.Fatal("the background build never stored the blob")
	}
	if got := dt.trending(tok, ""); len(got) != 4 {
		t.Errorf("after the build: %d entries", len(got))
	}

	// a stale blob still answers
	if _, err := dt.s.DB.Exec(`UPDATE anilist_cache SET fetched_at = '2000-01-01 00:00:00' WHERE key = ?`, tvTrendingKey); err != nil {
		t.Fatal(err)
	}
	if !dt.s.tvTrendingStale() {
		t.Fatal("aged blob not stale")
	}
	if got := dt.trending(tok, ""); len(got) != 4 {
		t.Errorf("stale blob: %d entries", len(got))
	}
	if n := np.hits.Load(); n != 0 {
		t.Errorf("%d provider requests", n)
	}
}
