package tvdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// hits counts episode-route requests, so a test can tell a cache hit from a
// refetch. Package-level because testServer is shared.
var hits atomic.Int64

// synthetic fixtures only; the Conan boundary (S33 ends at absolute 1186,
// S34E01 = 1187) is the case this whole feature exists for.
func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok123"},"status":"success"}`))
	})
	// only German is translated here; "deu" is what tvdbLang makes of de/de-DE
	mux.HandleFunc("/series/295/episodes/official/deu", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Query().Get("page") != "0" {
			w.Write([]byte(`{"data":{"episodes":[]},"links":{}}`))
			return
		}
		w.Write([]byte(`{"data":{"episodes":[
			{"id":901,"name":"Der letzte Fall","absoluteNumber":1186,"seasonNumber":33,"number":39,"aired":"2024-01-01"}
		]},"links":{}}`))
	})
	mux.HandleFunc("/series/295/episodes/official", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer tok123" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("page") != "0" { // single page
			w.Write([]byte(`{"data":{"episodes":[]},"links":{}}`))
			return
		}
		w.Write([]byte(`{"data":{"episodes":[
			{"id":901,"name":"The Last Case","absoluteNumber":1186,"seasonNumber":33,"number":39,"aired":"2024-01-01"},
			{"id":902,"name":"A New Start","absoluteNumber":1187,"seasonNumber":34,"number":1,"aired":"2024-01-08"},
			{"id":903,"name":"Recap","absoluteNumber":0,"seasonNumber":0,"number":5,"aired":""}
		]},"links":{}}`))
	})
	mux.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"tvdb_id":"295","name":"Detective Conan","year":"1996"}]}`))
	})
	return httptest.NewServer(mux)
}

func TestEpisodesAndMap(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")

	c := New(nil) // key comes from env, DB never touched
	if !c.Enabled() {
		t.Fatal("expected enabled")
	}
	eps, err := c.Episodes(context.Background(), 295, "official")
	if err != nil || len(eps) != 3 {
		t.Fatalf("episodes: %d %v", len(eps), err)
	}
	m := AbsoluteMap(eps)
	if got := m[1187]; got != [2]int{34, 1} {
		t.Errorf("1187 -> %v, want [34 1]", got)
	}
	if got := m[1186]; got != [2]int{33, 39} {
		t.Errorf("1186 -> %v, want [33 39]", got)
	}
	if _, ok := m[0]; ok {
		t.Error("absoluteNumber 0 should be dropped")
	}

	if eps[0].Name != "The Last Case" || eps[0].ID != 901 {
		t.Errorf("episode name/id not decoded: %+v", eps[0])
	}

	res, err := c.Search(context.Background(), "Detective Conan")
	if err != nil || len(res) != 1 || ParseID(res[0].TVDBID) != 295 {
		t.Fatalf("search: %v %v", res, err)
	}
}

// A series without the requested translation answers 404 on the localized
// route. Half a list of blank names would be worse than English ones, so the
// client falls back to the default list.
func TestEpisodesLangFallsBackToDefault(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")

	c := New(nil)
	// the fixture only translates German, so French 404s on the localized route
	eps, err := c.EpisodesLang(context.Background(), 295, "official", "fr")
	if err != nil {
		t.Fatalf("episodes: %v", err)
	}
	if len(eps) != 3 || eps[0].Name != "The Last Case" {
		t.Fatalf("want the default list, got %d: %+v", len(eps), eps)
	}
}

func TestEpisodesLangPrefersTheTranslation(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")

	c := New(nil)
	eps, err := c.EpisodesLang(context.Background(), 295, "official", "de-DE")
	if err != nil {
		t.Fatalf("episodes: %v", err)
	}
	// "de-DE" must resolve to the 3-letter code the route expects
	if len(eps) != 1 || eps[0].Name != "Der letzte Fall" {
		t.Fatalf("want the german list, got %d: %+v", len(eps), eps)
	}
}

// The full episode list of an endless series is a dozen paginated requests and
// gets refetched every time the episode modal opens.
func TestEpisodesCached(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")

	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	c := New(d)
	before := hits.Load()
	if _, err := c.Episodes(context.Background(), 295, "official"); err != nil {
		t.Fatal(err)
	}
	fetched := hits.Load() - before
	if fetched == 0 {
		t.Fatal("first call should reach the server")
	}
	if _, err := c.Episodes(context.Background(), 295, "official"); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load() - before; got != fetched {
		t.Errorf("second call made %d more requests, want a cache hit", got-fetched)
	}
}

func TestSeasonTokenMap(t *testing.T) {
	eps := []Episode{
		{AbsoluteNumber: 1165, SeasonNumber: 21, Number: 36},
		{AbsoluteNumber: 1166, SeasonNumber: 21, Number: 37},
		// a recap airing between 1165 and 1166 (before season 21 episode 37)
		{SeasonNumber: 0, Number: 31, AirsBeforeSeason: 21, AirsBeforeEpisode: 37},
	}
	m := SeasonTokenMap(eps)
	if m["1165"] != [2]int{21, 36} {
		t.Errorf("regular 1165 -> %v, want {21 36}", m["1165"])
	}
	if m["1165.5"] != [2]int{0, 31} {
		t.Errorf("special 1165.5 -> %v, want {0 31}", m["1165.5"])
	}
}

func TestNameTranslations(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok123"},"status":"success"}`))
	})
	mux.HandleFunc("/series/295/extended", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("meta") != "translations" {
			http.Error(w, "missing meta", http.StatusBadRequest)
			return
		}
		w.Write([]byte(`{"data":{"translations":{"nameTranslations":[
			{"language":"deu","name":"Detektiv Conan"},
			{"language":"eng","name":"Detective Conan"},
			{"language":"jpn","name":"名探偵コナン"},
			{"language":"xyz","name":"Odd"},
			{"language":"","name":"skipme"}]}}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")

	c := New(nil)
	tr, err := c.NameTranslations(context.Background(), 295)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"de": "Detektiv Conan", "en": "Detective Conan", "ja": "名探偵コナン", "xyz": "Odd"}
	if len(tr) != len(want) {
		t.Fatalf("translations: %v", tr)
	}
	for loc, name := range want {
		if tr[loc] != name {
			t.Errorf("%s: got %q, want %q", loc, tr[loc], name)
		}
	}
}
