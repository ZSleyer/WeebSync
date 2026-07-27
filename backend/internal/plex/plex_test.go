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
		w.Write([]byte(`{"MediaContainer":{"Directory":[
			{"key":"1","type":"show","title":"Anime","agent":"tv.plex.agents.series","Location":[{"path":"/media/anime"}]},
			{"key":"2","type":"movie","title":"Movies","agent":"tv.plex.agents.movie","Location":[{"path":"/media/movies"}]}]}}`))
	})
	mux.HandleFunc("/library/sections/1/all", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"10","title":"Example Show","year":2024,"leafCount":12,"childCount":1}]}}`))
	})
	// mirrors real PMS behavior: leaf listings omit Stream even with
	// includeStreams=1; only the episode metadata detail carries them
	mux.HandleFunc("/library/metadata/10/allLeaves", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"100","parentIndex":1,"Media":[{"videoResolution":"1080","Part":[
				{"id":501,"file":"/media/plex/series/Example_Show/Season 01/ep01.mkv"}]}]}]}}`))
	})
	mux.HandleFunc("/library/metadata/100", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"100","Media":[{"Part":[
				{"id":501,"file":"/media/plex/series/Example_Show/Season 01/ep01.mkv","Stream":[
					{"id":1,"streamType":1},
					{"id":2,"streamType":2,"language":"German","languageCode":"deu"},
					{"id":3,"streamType":2,"language":"Japanese","languageCode":"jpn"},
					{"id":4,"streamType":3,"language":"German","languageCode":"deu","forced":1,"displayTitle":"German (Forced)"},
					{"id":5,"streamType":3,"language":"German","languageCode":"deu","hearingImpaired":true,"title":"German SDH"},
					{"id":6,"streamType":3,"language":"German","languageCode":"deu"}]}]}]}]}}`))
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
	// a real PMS checks the token on every route, not just one
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plex-Token") != "test-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
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

	// per-episode parts carry ids for stream selection; leaf listing has no
	// streams (real PMS behavior), the detail fetch does
	parts, err := c.EpisodeParts("10")
	if err != nil || len(parts) != 1 {
		t.Fatalf("episode parts: %v %v", parts, err)
	}
	p := parts[0]
	if p.RatingKey != "100" || p.PartID != 501 || len(p.Streams) != 0 {
		t.Fatalf("part: %+v", p)
	}
	detail, err := c.PartStreams("100")
	if err != nil || len(detail) != 1 || detail[0].PartID != 501 || len(detail[0].Streams) != 6 {
		t.Fatalf("part streams: %+v %v", detail, err)
	}
	// the flags are what tells three German subtitle tracks apart. PMS writes
	// them as 1 and omits them when false, but builds differ and some send a
	// real JSON boolean, so both must decode.
	byID := map[int64]EpisodeStream{}
	for _, st := range detail[0].Streams {
		byID[st.ID] = st
	}
	if st := byID[4]; !st.Forced || st.Title != "German (Forced)" {
		t.Errorf("forced stream: %+v (title falls back to displayTitle)", st)
	}
	if st := byID[5]; !st.HearingImpaired || st.Forced {
		t.Errorf("SDH stream: %+v (hearingImpaired sent as a JSON boolean)", st)
	}
	if st := byID[6]; st.Forced || st.HearingImpaired || st.VisualImpaired {
		t.Errorf("plain stream carries a flag it was never sent: %+v", st)
	}
	if err := c.SetStreams(501, 3, 4); err != nil {
		t.Errorf("set streams: %v", err)
	}

	// Sections is memoised, so ask something that goes to the server every time
	c.Token = "wrong"
	if _, err := c.Shows("1"); err == nil {
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

// A forced subtitle track is signs and foreign dialogue, not a translation.
// Counting it as "this copy has German subtitles" is what made a remote copy
// with real German subtitles look like no improvement, so the upgrade was never
// offered. Audio has no such variant and always counts.
func TestMediaStreamCountsAs(t *testing.T) {
	cases := []struct {
		name string
		st   mediaStream
		want string
	}{
		{"a full subtitle track", mediaStream{StreamType: 3, LangCode: "deu"}, "deu"},
		{"a flagged forced subtitle", mediaStream{StreamType: 3, LangCode: "deu", Forced: true}, ""},
		{"forced only in the title", mediaStream{StreamType: 3, LangCode: "deu", Title: "German (Forced)"}, ""},
		{"forced only in Plex's display title", mediaStream{StreamType: 3, LangCode: "deu", DisplayTitle: "Deutsch (Erzwungen)"}, ""},
		{"a full track labelled as not forced", mediaStream{StreamType: 3, LangCode: "deu", Title: "German (Non-Forced)"}, "deu"},
		{"an audio track named forced still counts", mediaStream{StreamType: 2, LangCode: "deu", Title: "Forced"}, "deu"},
		{"languageCode wins over language", mediaStream{StreamType: 2, LangCode: "jpn", Language: "Japanese"}, "jpn"},
		{"language stands in when the code is absent", mediaStream{StreamType: 2, Language: "Japanese"}, "Japanese"},
	}
	for _, c := range cases {
		if got := c.st.countsAs(); got != c.want {
			t.Errorf("%s: countsAs = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestForcedTitle(t *testing.T) {
	for _, s := range []string{"Forced", "German (Forced)", "Deutsch (Erzwungen)", "Deutsch forciert"} {
		if !ForcedTitle(s) {
			t.Errorf("ForcedTitle(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "German", "German (Non-Forced)", "Deutsch nicht erzwungen", "German, not forced", "Signs & Songs"} {
		if ForcedTitle(s) {
			t.Errorf("ForcedTitle(%q) = true, want false", s)
		}
	}
}
