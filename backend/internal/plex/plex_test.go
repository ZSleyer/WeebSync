package plex

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// synthetic fixtures only, no real library data
func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/library/sections", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"MediaContainer":{"Directory":[
			{"key":"1","type":"show","title":"Anime","agent":"tv.plex.agents.series","Location":[{"path":"/media/anime"}]},
			{"key":"2","type":"movie","title":"Movies","agent":"tv.plex.agents.movie","Location":[{"path":"/media/movies"}]}]}}`))
	})
	mux.HandleFunc("/library/sections/1/all", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"10","title":"Example Show","year":2024,"leafCount":12,"childCount":1}]}}`))
	})
	mux.HandleFunc("/library/metadata/10/allLeaves", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"100","parentIndex":1,"Media":[{"videoResolution":"1080","Part":[
				{"id":501,"file":"/media/plex/series/Example_Show/Season 01/ep01.mkv","Stream":[
					{"id":1,"streamType":1},
					{"id":2,"streamType":2,"language":"German","languageCode":"deu"},
					{"id":3,"streamType":2,"language":"Japanese","languageCode":"jpn"},
					{"id":4,"streamType":3,"language":"German","languageCode":"deu"}]}]}]}]}}`))
	})
	mux.HandleFunc("/library/parts/501", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		if q.Get("allParts") != "1" || q.Get("audioStreamID") != "3" || q.Get("subtitleStreamID") != "4" {
			http.Error(w, "params", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/library/metadata/10", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("includePreferences") == "1" {
			w.Write([]byte(`{"MediaContainer":{"Metadata":[{"Preferences":{"Setting":[
				{"id":"showOrdering","value":"tvdbDvd"},
				{"id":"languageOverride","value":"de-DE"}]}}]}}`))
			return
		}
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"10","title":"Example Show","originalTitle":"例のショー","year":2024,"leafCount":12,
			 "Location":[{"path":"/media/plex/series/Example_Show"}],
			 "Guid":[{"id":"imdb://tt1234"},{"id":"tvdb://295"},{"id":"tmdb://30983"}]}]}}`))
	})
	return httptest.NewServer(mux)
}

func TestClient(t *testing.T) {
	srv := testServer(t)
	defer srv.Close()
	c := New(srv.URL+"/", "test-token") // trailing slash gets trimmed

	secs, err := c.Sections()
	if err != nil || len(secs) != 2 || secs[0].Key != "1" {
		t.Fatalf("sections: %v %v", secs, err)
	}
	shows, err := c.Shows("1")
	if err != nil || len(shows) != 1 || shows[0].LeafCount != 12 {
		t.Fatalf("shows: %v %v", shows, err)
	}
	d, err := c.ShowDetail("10")
	if err != nil || len(d.Locations) != 1 || d.Locations[0] != "/media/plex/series/Example_Show" {
		t.Fatalf("detail: %+v %v", d, err)
	}
	if d.OriginalTitle == "" {
		t.Error("originalTitle missing")
	}
	if d.TVDBID != 295 {
		t.Errorf("tvdb id: got %d, want 295", d.TVDBID)
	}
	if d.TMDBID != 30983 {
		t.Errorf("tmdb id: got %d, want 30983", d.TMDBID)
	}
	// per-show ordering + language override
	o, err := c.ShowPreferences("10")
	if err != nil || o.Provider != "tvdb" || o.Order != "dvd" || o.Language != "de-DE" {
		t.Fatalf("prefs: %+v %v", o, err)
	}
	// path -> library (longest prefix)
	if lib, ok := c.LibraryForPath("/media/anime/Some Show/ep01.mkv"); !ok || lib.Key != "1" || lib.Agent != "tv.plex.agents.series" {
		t.Errorf("LibraryForPath: %+v %v", lib, ok)
	}
	if _, ok := c.LibraryForPath("/somewhere/else"); ok {
		t.Error("unrelated path must not match a library")
	}

	// per-episode parts carry ids for stream selection
	parts, err := c.EpisodeParts("10")
	if err != nil || len(parts) != 1 {
		t.Fatalf("episode parts: %v %v", parts, err)
	}
	p := parts[0]
	if p.RatingKey != "100" || p.PartID != 501 || len(p.Streams) != 4 {
		t.Fatalf("part: %+v", p)
	}
	if err := c.SetStreams(501, 3, 4); err != nil {
		t.Errorf("set streams: %v", err)
	}

	c.Token = "wrong"
	if _, err := c.Sections(); err == nil {
		t.Error("expected auth error")
	}
}

func TestShowOrderingMap(t *testing.T) {
	cases := map[string][2]string{
		"tmdbAiring":   {"tmdb", "aired"},
		"tvdbAiring":   {"tvdb", "official"},
		"aired":        {"tvdb", "official"},
		"tvdbDvd":      {"tvdb", "dvd"},
		"tvdbAbsolute": {"tvdb", "absolute"},
		"":             {"", ""},
	}
	for in, want := range cases {
		if p, o := showOrderingMap(in); p != want[0] || o != want[1] {
			t.Errorf("%q -> (%q,%q), want %v", in, p, o, want)
		}
	}
}

func TestAgentProvider(t *testing.T) {
	cases := map[string]string{
		"com.plexapp.agents.thetvdb":    "tvdb",
		"com.plexapp.agents.hama":       "tvdb",
		"com.plexapp.agents.themoviedb": "tmdb",
		"tv.plex.agents.movie":          "tmdb",
		"tv.plex.agents.series":         "", // ambiguous: the ordering decides
		"":                              "",
	}
	for in, want := range cases {
		if got := agentProvider(in); got != want {
			t.Errorf("agentProvider(%q) = %q, want %q", in, got, want)
		}
	}
}
