package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/transfer"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// autoFixture is a server with all three providers answering public titles;
// the counters say how often each was asked.
type autoFixture struct {
	s                      *Server
	anilistN, tvdbN, tmdbN *atomic.Int32
}

// fakeTvdbAuto answers the few TVDB routes a match needs. Titles: id 7 "Neo
// Yokio" (2017), id 8 "Death Note" (a live-action remake, 2017), id 9
// "Castlevania" (2017).
func fakeTvdbAuto(t *testing.T, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok"},"status":"success"}`))
	})
	mux.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("type") == "movie" {
			w.Write([]byte(`{"data":[]}`))
			return
		}
		switch strings.ToLower(r.URL.Query().Get("query")) {
		case "neo yokio":
			w.Write([]byte(`{"data":[{"tvdb_id":"7","name":"Neo Yokio","year":"2017","image_url":"https://img.example/7.jpg","overview":"x"}]}`))
		case "death note":
			w.Write([]byte(`{"data":[{"tvdb_id":"8","name":"Death Note","year":"2017","image_url":"https://img.example/8.jpg","overview":"x"}]}`))
		case "castlevania":
			w.Write([]byte(`{"data":[{"tvdb_id":"9","name":"Castlevania","year":"2017","image_url":"https://img.example/9.jpg","overview":"x"}]}`))
		default:
			w.Write([]byte(`{"data":[]}`))
		}
	})
	mux.HandleFunc("/series/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.Split(strings.TrimPrefix(r.URL.Path, "/series/"), "/")[0]
		names := map[string]string{"7": "Neo Yokio", "8": "Death Note", "9": "Castlevania"}
		n, ok := names[id]
		if !ok || strings.Contains(r.URL.Path, "translations") {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"data":{"id":` + id + `,"name":"` + n + `","image":"https://img.example/` + id + `.jpg","overview":"x","year":"2017","firstAired":"2017-01-01","episodes":[{"seasonNumber":1,"number":1,"aired":"2017-01-01"}]}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// fakeTmdbAuto: tv 11 "Neo Yokio" (300 votes), 12 "Death Note" (900 votes),
// 13 "Unrated Story" (3 votes); film 31 "The Red Turtle" (900 votes).
func fakeTmdbAuto(t *testing.T, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	row := func(id int, name, date string, votes int) string {
		i := strconv.Itoa(id)
		return `{"id":` + i + `,"name":"` + name + `","title":"` + name + `","original_name":"` + name + `","original_title":"` + name +
			`","first_air_date":"` + date + `","release_date":"` + date + `","poster_path":"/p.jpg","overview":"x","vote_count":` + strconv.Itoa(votes) + `}`
	}
	mux.HandleFunc("/search/tv", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch strings.ToLower(r.URL.Query().Get("query")) {
		case "neo yokio":
			w.Write([]byte(`{"results":[` + row(11, "Neo Yokio", "2017-09-22", 300) + `]}`))
		case "death note":
			w.Write([]byte(`{"results":[` + row(12, "Death Note", "2017-01-01", 900) + `]}`))
		case "unrated story":
			w.Write([]byte(`{"results":[` + row(13, "Unrated Story", "2018-01-01", 3) + `]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	})
	mux.HandleFunc("/search/movie", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.ToLower(r.URL.Query().Get("query")) == "the red turtle" {
			w.Write([]byte(`{"results":[` + row(31, "The Red Turtle", "2016-05-18", 900) + `]}`))
			return
		}
		w.Write([]byte(`{"results":[]}`))
	})
	for id, n := range map[int]string{11: "Neo Yokio", 12: "Death Note", 13: "Unrated Story"} {
		mux.HandleFunc("/tv/"+strconv.Itoa(id), func(w http.ResponseWriter, r *http.Request) {
			votes := 300
			if id == 13 {
				votes = 3
			}
			w.Write([]byte(`{"id":` + strconv.Itoa(id) + `,"name":"` + n + `","original_name":"` + n + `","first_air_date":"2017-09-22","poster_path":"/p.jpg","overview":"x","vote_count":` +
				strconv.Itoa(votes) + `,"number_of_episodes":6,"seasons":[{"season_number":1,"episode_count":6}]}`))
		})
	}
	mux.HandleFunc("/movie/31", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(row(31, "The Red Turtle", "2016-05-18", 900)))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// newAutoFixture builds a server whose AniList knows entries, TMDB and TVDB
// the shows above; the keys of the providers in off are left out.
func newAutoFixture(t *testing.T, entries []fakeEntry, off ...string) *autoFixture {
	t.Helper()
	f := &autoFixture{anilistN: new(atomic.Int32), tvdbN: new(atomic.Int32), tmdbN: new(atomic.Int32)}
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	if _, err := d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`); err != nil {
		t.Fatal(err)
	}
	srv := &Server{DB: d, Anilist: fakeSearchAnilist(t, entries, f.anilistN)}
	srv.Tmdb = tmdb.New(d)
	srv.Tmdb.BaseURL = fakeTmdbAuto(t, f.tmdbN).URL
	srv.Tvdb = tvdb.New(d)
	srv.Tvdb.BaseURL = fakeTvdbAuto(t, f.tvdbN).URL
	keyed := map[string]string{"tmdb": "tmdb_api_key", "tvdb": "tvdb_api_key"}
	for p, key := range keyed {
		skip := false
		for _, o := range off {
			skip = skip || o == p
		}
		if !skip {
			if err := db.SetSetting(d, key, "test.jwt.token"); err != nil {
				t.Fatal(err)
			}
		}
	}
	f.s = testServer(t, srv)
	return f
}

// route stores a routing, starting from the defaults.
func (f *autoFixture) route(t *testing.T, edit func(r *matchRouting)) {
	t.Helper()
	r := defaultRouting()
	edit(&r)
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetSetting(f.s.DB, matchRoutingKey, string(raw)); err != nil {
		t.Fatal(err)
	}
}

// list builds a routing list from provider names; a leading "-" switches one off.
func list(names ...string) []routeEntry {
	var out []routeEntry
	for _, n := range names {
		out = append(out, routeEntry{Provider: strings.TrimPrefix(n, "-"), Enabled: !strings.HasPrefix(n, "-")})
	}
	return out
}

// matchOf runs the automatic match for a folder under /lib and waits for the
// row it stores: its source and media id.
func (f *autoFixture) matchOf(t *testing.T, name string) (string, int) {
	t.Helper()
	folder := "/lib/" + name
	f.s.queueAutoMatch(1, folder, name, false)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var src string
		var id int
		err := f.s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = 1 AND folder = ?`, folder).Scan(&src, &id)
		if err == nil {
			return src, id
		}
		if err != sql.ErrNoRows {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s: no match row stored", name)
	return "", 0
}

func (f *autoFixture) asked() (int32, int32, int32) {
	return f.anilistN.Load(), f.tvdbN.Load(), f.tmdbN.Load()
}

var autoAnimeEntries = []fakeEntry{
	{ID: 1535, Romaji: "Death Note", Format: "TV", Year: 2006},
	{ID: 21, Romaji: "Mewkledreamy", Format: "TV", Year: 2020},
}

// Anime lists ask AniList, TVDB, TMDB; a provider is asked only when the one
// before gave no confident match. A name with western audio or a streaming tag
// reads as no anime: the series list has AniList off.
func TestAutoOrder(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	if src, id := f.matchOf(t, "Death Note [JapDub,GerSub]"); src != "anilist" || id != 1535 {
		t.Errorf("anime: %s %d", src, id)
	}
	if _, tv, tm := f.asked(); tv != 0 || tm != 0 {
		t.Errorf("providers asked behind a confident AniList match: tvdb %d tmdb %d", tv, tm)
	}
	// nothing in the name: an anime; AniList lacks it, TVDB is next
	if src, id := f.matchOf(t, "Neo Yokio"); src != "tvdb" || id != 7 {
		t.Errorf("unclear name: %s %d", src, id)
	}
	if _, _, tm := f.asked(); tm != 0 {
		t.Errorf("TMDB asked although TVDB matched: %d", tm)
	}
	// English audio and a streaming tag: the series list, AniList is off in it
	before, _, _ := f.asked()
	if src, id := f.matchOf(t, "Death Note [EngDub,NF]"); src != "tvdb" || id != 8 {
		t.Errorf("western: %s %d", src, id)
	}
	if after, _, _ := f.asked(); after != before {
		t.Error("AniList asked for a name that reads as western")
	}
}

// The stored order is respected, a provider switched off in a list is skipped,
// and a list with nothing on matches nothing.
func TestAutoRoutingLists(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	f.route(t, func(r *matchRouting) { r.AnimeSeries = list("anilist", "tmdb", "tvdb") })
	if src, id := f.matchOf(t, "Neo Yokio"); src != "tmdb:tv" || id != 11 {
		t.Errorf("TMDB before TVDB: %s %d", src, id)
	}
	if _, tv, _ := f.asked(); tv != 0 {
		t.Errorf("TVDB asked behind TMDB's match: %d", tv)
	}
	g := newAutoFixture(t, autoAnimeEntries)
	g.route(t, func(r *matchRouting) { r.AnimeSeries = list("anilist", "-tvdb", "tmdb") })
	if src, id := g.matchOf(t, "Neo Yokio"); src != "tmdb:tv" || id != 11 {
		t.Errorf("TVDB switched off: %s %d", src, id)
	}
	if _, tv, _ := g.asked(); tv != 0 {
		t.Errorf("a switched-off entry was asked: %d", tv)
	}
	h := newAutoFixture(t, autoAnimeEntries)
	h.route(t, func(r *matchRouting) { r.AnimeSeries = list("-anilist", "-tvdb", "-tmdb") })
	if src, id := h.matchOf(t, "Neo Yokio"); src != "anilist" || id != 0 {
		t.Errorf("empty list: %s %d", src, id)
	}
	if a, tv, tm := h.asked(); a+tv+tm != 0 {
		t.Errorf("an empty list asked %d %d %d", a, tv, tm)
	}
}

// Films have lists of their own: AniList, then TMDB, then TVDB for an anime
// film; a film that reads as western goes to TMDB first.
func TestAutoMovieLists(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	folder := "/lib/The Red Turtle [EngDub]"
	f.s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,0)`,
		folder+"/The Red Turtle.mkv", folder, "The Red Turtle.mkv")
	if src, id := f.matchOf(t, "The Red Turtle [EngDub]"); src != "tmdb:movie" || id != 31 {
		t.Errorf("film: %s %d", src, id)
	}
	if _, tv, _ := f.asked(); tv != 0 {
		t.Errorf("TVDB asked for a film TMDB had: %d", tv)
	}
}

// A provider without a key is skipped.
func TestAutoSkipsUnconfigured(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries, "tvdb")
	if src, id := f.matchOf(t, "Neo Yokio"); src != "tmdb:tv" || id != 11 {
		t.Errorf("without TVDB: %s %d", src, id)
	}
	if _, tv, _ := f.asked(); tv != 0 {
		t.Errorf("TVDB asked without a key: %d", tv)
	}
	g := newAutoFixture(t, autoAnimeEntries, "tvdb", "tmdb")
	if src, id := g.matchOf(t, "Neo Yokio"); src != "anilist" || id != 0 {
		t.Errorf("AniList only: %s %d", src, id)
	}
	if _, tv, tm := g.asked(); tv != 0 || tm != 0 {
		t.Error("an unconfigured provider was asked")
	}
}

// A provider switch overrides the lists: a provider that is off is never
// asked, whatever the lists say; with all of them off nothing is matched,
// not by the sweep, a listing or an explicit mark either.
func TestProviderSwitches(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	f.route(t, func(r *matchRouting) { r.Providers.Tvdb = false })
	if src, id := f.matchOf(t, "Neo Yokio"); src != "tmdb:tv" || id != 11 {
		t.Errorf("TVDB switched off: %s %d", src, id)
	}
	if _, tv, _ := f.asked(); tv != 0 {
		t.Errorf("TVDB asked while switched off: %d", tv)
	}
	g := newAutoFixture(t, autoAnimeEntries)
	g.route(t, func(r *matchRouting) { r.Providers.Anilist = false })
	if src, id := g.matchOf(t, "Death Note"); src != "tvdb" || id != 8 {
		t.Errorf("AniList switched off: %s %d", src, id)
	}
	if a, _, _ := g.asked(); a != 0 {
		t.Errorf("AniList asked while switched off: %d", a)
	}

	h := newAutoFixture(t, autoAnimeEntries)
	h.route(t, func(r *matchRouting) { r.Providers = routeSwitches{} })
	if !h.s.matchingOff() {
		t.Fatal("matchingOff = false with every switch off")
	}
	h.s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/lib', 'auto'), (1, '/tv', 'tvdb')`)
	h.s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,'/lib/Neo Yokio','/lib','Neo Yokio',1), (1,'/tv/Neo Yokio','/tv','Neo Yokio',1)`)
	h.s.sweepServer(t.Context(), 1, 50)
	h.s.queueScopedMatch(1, "/lib/Neo Yokio", "Neo Yokio", scopeAuto, false)
	h.s.queueScopedMatch(1, "/tv/Neo Yokio", "Neo Yokio", "tvdb", true)
	time.Sleep(300 * time.Millisecond)
	var n int
	if err := h.s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows stored with matching off: %d %v", n, err)
	}
	if a, tv, tm := h.asked(); a+tv+tm != 0 {
		t.Errorf("providers asked with matching off: %d %d %d", a, tv, tm)
	}
	if h.s.scopeMatchable("tvdb") || h.s.scopeMatchable(scopeAuto) {
		t.Error("scopeMatchable with every switch off")
	}
	// one switch off only stops the marks of that provider
	f.route(t, func(r *matchRouting) { r.Providers.Tmdb = false })
	if f.s.scopeMatchable("tv") || !f.s.scopeMatchable("tvdb") || !f.s.scopeMatchable("anime") || !f.s.scopeMatchable(scopeAuto) {
		t.Error("scopeMatchable ignores which switch is off")
	}
}

// Behind AniList a provider has to pass the strict gate: an entry nobody rated
// is no match, and neither is a one-word name without a year.
func TestAutoStrictGate(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries, "tvdb")
	if src, id := f.matchOf(t, "Unrated Story"); id != 0 {
		t.Errorf("an unrated entry matched: %s %d", src, id)
	}
	g := newAutoFixture(t, autoAnimeEntries, "tmdb")
	if _, id := g.matchOf(t, "Castlevania"); id != 0 {
		t.Errorf("a one-word name without a year matched: %d", id)
	}
	if src, id := g.matchOf(t, "Castlevania (2017)"); src != "tvdb" || id != 9 {
		t.Errorf("one word with its year: %s %d", src, id)
	}
}

// A title that exists as an anime stays on AniList.
func TestAutoAnimeKeepsAniList(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	if src, id := f.matchOf(t, "Death Note (2006) [JapDub]"); src != "anilist" || id != 1535 {
		t.Errorf("%s %d", src, id)
	}
}

// A season folder follows the provider its sibling season is on.
func TestAutoSiblingProvider(t *testing.T) {
	f := newAutoFixture(t, []fakeEntry{{ID: 5, Romaji: "Neo Yokio", Format: "TV", Year: 2017}})
	if err := f.s.persistMatch(1, "/lib/Neo Yokio", 7, false, "tvdb"); err != nil {
		t.Fatal(err)
	}
	// AniList would take "Neo Yokio" for this folder; its sibling is on TVDB
	if src, id := f.matchOf(t, "Neo Yokio S2"); src != "tvdb" || id != 7 {
		t.Errorf("season folder: %s %d", src, id)
	}
	// a title that only shares a start follows nobody
	if src, id := f.matchOf(t, "Neo Yokio Extra S2"); src == "tvdb" || id == 7 {
		t.Errorf("an unrelated title followed the sibling: %s %d", src, id)
	}
}

// A manual match is never replaced, from any source.
func TestAutoKeepsManualMatch(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	folder := "/lib/Death Note [JapDub]"
	if err := f.s.persistMatch(1, folder, 11, true, "tmdb:tv"); err != nil {
		t.Fatal(err)
	}
	f.s.matchBatch([]matchJob{{serverID: 1, folder: folder, name: "Death Note [JapDub]", auto: &autoPlan{rest: []string{"tvdb", "tmdb"}}}})
	f.s.queueAutoMatch(1, folder, "Death Note [JapDub]", false)
	time.Sleep(300 * time.Millisecond)
	var id, manual int
	var src string
	if err := f.s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches WHERE folder = ?`, folder).Scan(&id, &manual, &src); err != nil {
		t.Fatal(err)
	}
	if id != 11 || manual != 1 || src != "tmdb:tv" {
		t.Fatalf("the manual match changed: %d %d %s", id, manual, src)
	}
}

// Folders that are no title are looked up nowhere and store no match.
func TestAutoNoTitleNoMatch(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	for _, n := range []string{"Anime Movies", "Music Videos", "Software", "Downloads [GerDub]"} {
		if _, id := f.matchOf(t, n); id != 0 {
			t.Errorf("%q matched %d", n, id)
		}
	}
	// a container of other titles
	for _, n := range []string{"Alpha", "Beta", "Gamma"} {
		f.s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,1)`,
			"/lib/Death Note Pile/"+n, "/lib/Death Note Pile", n)
	}
	if _, id := f.matchOf(t, "Death Note Pile"); id != 0 {
		t.Errorf("a container matched %d", id)
	}
	if a, tv, tm := f.asked(); a+tv+tm != 0 {
		t.Errorf("providers asked for non-titles: %d %d %d", a, tv, tm)
	}
}

// Without the mark nothing is automatic: an anime scope asks AniList alone.
func TestAutoNotActiveUnlessChosen(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	f.s.queueScopedMatch(1, "/lib/Neo Yokio", "Neo Yokio", "anime", false)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if f.s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE folder = '/lib/Neo Yokio'`).Scan(&n) == nil && n == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	var src string
	var id int
	if err := f.s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE folder = '/lib/Neo Yokio'`).Scan(&src, &id); err != nil {
		t.Fatal(err)
	}
	// (the unmatched folder may get a hint from the other providers; a match it never gets)
	if src != "anilist" || id != 0 {
		t.Errorf("anime scope: %s %d", src, id)
	}
}

// The mark itself: stored, read back, and its folders take the source of their match.
func TestAutoScopeMark(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	if _, err := f.s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/lib', 'auto')`); err != nil {
		t.Fatal(err)
	}
	if got := f.s.scopeFor(1, "/lib"); got != scopeAuto {
		t.Fatalf("scope = %q", got)
	}
	for _, c := range []struct{ scope, stored, want string }{
		{scopeAuto, "tvdb", "tvdb"}, {scopeAuto, "tmdb:movie", "tmdb:movie"}, {scopeAuto, "", "anilist"},
		{scopeAuto, mangaSource, "anilist"}, {"tv", "anilist", "tmdb:tv"}, {"anime", "tvdb", "anilist"},
	} {
		if got := expectedSource(c.scope, c.stored); got != c.want {
			t.Errorf("expectedSource(%s, %s) = %s, want %s", c.scope, c.stored, got, c.want)
		}
	}
}

// The routing is an admin setting: validated on save (known providers, no
// duplicates, every provider listed), an empty list is fine, a refused save
// stores nothing, and the defaults are what an install without a value gets.
func TestRoutingSetting(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	put := func(body string) *httptest.ResponseRecorder { return doReq(mux, "PUT", "/api/settings", body, adminC) }
	if r := s.routing(); len(r.AnimeSeries) != 3 || r.AnimeSeries[0].Provider != "anilist" || r.Series[0].Enabled ||
		r.Movie[0].Provider != "anilist" || r.Movie[1].Provider != "tmdb" || !r.Providers.Tvdb {
		t.Fatalf("defaults = %+v", r)
	}
	for _, bad := range []string{
		`{"matchRouting":{"series":[{"provider":"nope","enabled":true},{"provider":"tvdb","enabled":true},{"provider":"tmdb","enabled":true}]}}`,
		`{"matchRouting":{"series":[{"provider":"tvdb","enabled":true},{"provider":"tvdb","enabled":true},{"provider":"tmdb","enabled":true}]}}`,
		`{"matchRouting":{"movie":[{"provider":"tvdb","enabled":true}]}}`,
	} {
		rec := put(bad)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "matchRouting:") {
			t.Errorf("%s: got %d %s, want 400", bad, rec.Code, rec.Body)
		}
	}
	if v := db.Setting(s.DB, matchRoutingKey); v != "" {
		t.Errorf("a refused save stored %q", v)
	}
	ok := put(`{"matchRouting":{"providers":{"anilist":false,"tvdb":true,"tmdb":true},"series":[{"provider":"tmdb","enabled":true},{"provider":"tvdb","enabled":false},{"provider":"anilist","enabled":false}]}}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("valid routing refused: %d %s", ok.Code, ok.Body)
	}
	r := s.routing()
	if r.Providers.Anilist || r.Series[0].Provider != "tmdb" || r.Series[1].Enabled || len(r.AnimeSeries) != 3 || r.AnimeSeries[0].Provider != "anilist" {
		t.Errorf("stored routing = %+v", r)
	}
	// every list empty is allowed: it only matches nothing
	if rec := put(`{"matchRouting":{"series":[{"provider":"tmdb","enabled":false},{"provider":"tvdb","enabled":false},{"provider":"anilist","enabled":false}]}}`); rec.Code != http.StatusOK {
		t.Errorf("an empty list was refused: %d %s", rec.Code, rec.Body)
	}
	// a stored value that no longer validates reads as the defaults
	db.SetSetting(s.DB, matchRoutingKey, `{"series":[]}`)
	if got := s.routing(); len(got.Series) != 3 {
		t.Errorf("invalid stored routing not replaced by the defaults: %+v", got)
	}
}

// A hint comes from the routing's series list for a series, TVDB before TMDB,
// from its film list for a film, TMDB before TVDB; a list with nothing on
// offers none; the hint can be taken as a manual match of its own source.
func TestHintRouting(t *testing.T) {
	f := newAutoFixture(t, autoAnimeEntries)
	hint := func(name string) *matchHint {
		t.Helper()
		folder := "/lib/" + name
		info := matchInfo(name)
		if err := f.s.hintFolder(t.Context(), 1, folder, name, info, true); err != nil {
			t.Fatal(err)
		}
		return f.s.hintFor(1, folder)
	}
	if h := hint("Neo Yokio [EngDub]"); h == nil || h.Source != "tvdb" || h.MediaID != 7 {
		t.Errorf("series hint = %+v", h)
	}
	if _, _, tm := f.asked(); tm != 0 {
		t.Errorf("TMDB asked for a series TVDB had: %d", tm)
	}
	folder := "/lib/The Red Turtle [EngDub]"
	f.s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1,?,?,?,0)`,
		folder+"/The Red Turtle.mkv", folder, "The Red Turtle.mkv")
	if h := hint("The Red Turtle [EngDub]"); h == nil || h.Source != "tmdb:movie" || h.MediaID != 31 {
		t.Errorf("film hint = %+v", h)
	}
	// TVDB switched off: TMDB's show
	f.route(t, func(r *matchRouting) { r.Providers.Tvdb = false })
	if h := hint("Neo Yokio [EngDub,NF]"); h == nil || h.Source != "tmdb:tv" || h.MediaID != 11 {
		t.Errorf("series hint without TVDB = %+v", h)
	}
	// nothing on in the list: no hint
	f.route(t, func(r *matchRouting) { r.Series = list("-anilist", "-tvdb", "-tmdb") })
	if h := hint("Neo Yokio [EngDub,GerSub]"); h != nil {
		t.Errorf("hint from an empty list: %+v", h)
	}
	// a hint of TVDB is stored and can be taken as the matching manual match
	if _, err := f.s.DB.Exec(`INSERT INTO match_hints (server_id, folder, state, source, media_id, title, year, checked_at) VALUES (1,'/x','hint','tvdb:movie',5,'x',2000,1)`); err != nil {
		t.Errorf("the store refuses a TVDB film hint: %v", err)
	}
}

func matchInfo(name string) match.Info {
	return match.ParseName(name, GuessTitle(name), GuessAltTitle(name))
}
