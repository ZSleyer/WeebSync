package crunchyroll

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The anonymous token flow, and the three listings the dub recorder reads:
// seasons with their language versions, a season's episodes with theirs, and
// the versions themselves by id, which is where a dub's release date is.
func TestAnonymousBrowsing(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/v1/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != webClient || r.FormValue("grant_type") != "client_id" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Write([]byte(`{"access_token":"anon","expires_in":300,"token_type":"Bearer"}`))
	})
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer anon" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/content/v2/cms/series/GRGG9798R/seasons", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"total":1,"data":[{"id":"GS00371932JAJP","season_number":5,"title":"Season 4","audio_locale":"ja-JP",
			"versions":[{"audio_locale":"ja-JP","guid":"GS00371932JAJP","original":true},{"audio_locale":"de-DE","guid":"GS00371932DEDE","original":false}]}]}`))
	}))
	mux.HandleFunc("/content/v2/cms/seasons/GS00371932JAJP/episodes", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"total":2,"data":[
			{"id":"GE00345561JAJP","episode_number":13,"audio_locale":"ja-JP","episode_air_date":"2026-08-19T00:00:00Z","premium_available_date":"2026-08-19T14:00:00Z",
			 "versions":[{"audio_locale":"ja-JP","guid":"GE00345561JAJP","original":true},{"audio_locale":"de-DE","guid":"GE00345561DEDE","original":false}]},
			{"id":"GE00345564JAJP","episode_number":14,"audio_locale":"ja-JP","episode_air_date":"2026-08-26T00:00:00Z","premium_available_date":"2026-08-26T14:00:00Z",
			 "versions":[{"audio_locale":"ja-JP","guid":"GE00345564JAJP","original":true}]}]}`))
	}))
	mux.HandleFunc("/content/v2/cms/objects/GE00345561DEDE", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"total":1,"data":[{"id":"GE00345561DEDE","type":"episode","episode_metadata":{"episode_number":13,"audio_locale":"de-DE",
			"episode_air_date":"2026-08-19T00:00:00Z","premium_available_date":"2026-09-09T14:00:00Z","availability_starts":"9998-11-30T17:45:00Z"}}]}`))
	}))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := NewAt(srv.URL)
	ctx := context.Background()

	seasons, err := c.Seasons(ctx, "GRGG9798R")
	if err != nil || len(seasons) != 1 || seasons[0].Versions[1].AudioLocale != "de-DE" {
		t.Fatalf("seasons = %+v, %v", seasons, err)
	}
	eps, err := c.Episodes(ctx, seasons[0].ID)
	if err != nil || len(eps) != 2 || eps[0].Number != 13 || len(eps[0].Versions) != 2 || len(eps[1].Versions) != 1 {
		t.Fatalf("episodes = %+v, %v", eps, err)
	}
	objs, err := c.Objects(ctx, []string{"GE00345561DEDE"})
	if err != nil || len(objs) != 1 || objs[0].ID != "GE00345561DEDE" || objs[0].Number != 13 {
		t.Fatalf("objects = %+v, %v", objs, err)
	}
	if At(objs[0].PremiumAt) != 1788962400 { // 2026-09-09T14:00:00Z
		t.Errorf("premium at = %d", At(objs[0].PremiumAt))
	}
	if At("9998-11-30T17:45:00Z") != 0 || At("") != 0 {
		t.Error("placeholder dates should read as unknown")
	}
	if _, err := c.Seasons(ctx, "../etc"); err == nil {
		t.Error("an id that is not an id must be refused before it reaches the URL")
	}
}

func TestSeriesID(t *testing.T) {
	for u, want := range map[string]string{
		"https://www.crunchyroll.com/series/GRGG9798R":                    "GRGG9798R",
		"https://www.crunchyroll.com/de/series/GT00366791/oshi-no-ko":     "GT00366791",
		"http://www.crunchyroll.com/one-piece":                            "",
		"https://www.crunchyroll.com/de/watch/GE00345561DEDE/stay-by-her": "",
	} {
		if got := SeriesID(u); got != want {
			t.Errorf("SeriesID(%q) = %q, want %q", u, got, want)
		}
	}
}
