package tvdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// synthetic fixtures only; the Conan boundary (S33 ends at absolute 1186,
// S34E01 = 1187) is the case this whole feature exists for.
func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok123"},"status":"success"}`))
	})
	mux.HandleFunc("/series/295/episodes/official", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok123" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("page") != "0" { // single page
			w.Write([]byte(`{"data":{"episodes":[]},"links":{}}`))
			return
		}
		w.Write([]byte(`{"data":{"episodes":[
			{"absoluteNumber":1186,"seasonNumber":33,"number":39,"aired":"2024-01-01"},
			{"absoluteNumber":1187,"seasonNumber":34,"number":1,"aired":"2024-01-08"},
			{"absoluteNumber":0,"seasonNumber":0,"number":5,"aired":""}
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

	res, err := c.Search(context.Background(), "Detective Conan")
	if err != nil || len(res) != 1 || ParseID(res[0].TVDBID) != 295 {
		t.Fatalf("search: %v %v", res, err)
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
