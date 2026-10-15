package tvdb

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The record's own overview is in the show's language - Japanese for an
// anime. The German translation takes its place, English where there is none.
func TestMediaOverviewIsLocalized(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok"}}`))
	})
	mux.HandleFunc("/series/1/extended", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"id":1,"name":"名探偵コナン","overview":"日本語のあらすじ","year":"1996"}}`))
	})
	mux.HandleFunc("/series/1/translations/deu", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"name":"Detektiv Conan","overview":"Deutsche Beschreibung"}}`))
	})
	mux.HandleFunc("/series/2/extended", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"id":2,"name":"ワンピース","overview":"日本語"}}`))
	})
	mux.HandleFunc("/series/2/translations/eng", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"name":"One Piece","overview":"English overview"}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")
	c := New(dbtest.Open(t))

	m, err := c.Media(context.Background(), 1)
	if err != nil || m.Title.Romaji != "Detektiv Conan" || m.Description != "Deutsche Beschreibung" || m.Descriptions["de"] != "Deutsche Beschreibung" {
		t.Fatalf("german: %+v %v", m, err)
	}
	m, err = c.Media(context.Background(), 2)
	if err != nil || m.Title.English != "One Piece" || m.Description != "English overview" || m.Descriptions["en"] != "English overview" || m.Descriptions["de"] != "" {
		t.Fatalf("english fallback: title %q desc %q %v", m.Title.English, m.Description, err)
	}
}

// An endless anime on TVDB carries what its AniList entry did: the genres, and
// the next episode by its absolute number at the Japanese air time, counted
// when TVDB has not numbered it yet. Specials do not count.
func TestEnrichEndlessAnime(t *testing.T) {
	var r seriesRecord
	if err := json.Unmarshal([]byte(`{
		"genres": [{"name": "Mystery"}, {"name": "Anime"}],
		"airsTime": "18:00", "originalCountry": "jpn",
		"episodes": [
			{"seasonNumber": 34, "number": 2, "aired": "2026-10-24"},
			{"seasonNumber": 0, "number": 1, "aired": "2026-10-10"},
			{"seasonNumber": 33, "number": 1, "absoluteNumber": 1, "aired": "2026-10-03"},
			{"seasonNumber": 34, "number": 1, "aired": "2026-10-17"}
		]}`), &r); err != nil {
		t.Fatal(err)
	}
	var m anilist.Media
	r.enrich(&m, time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	if len(m.Genres) != 2 || m.Genres[1] != "Anime" {
		t.Errorf("genres %v", m.Genres)
	}
	if m.Episodes != 3 {
		t.Errorf("episodes %d, want the 3 regular ones", m.Episodes)
	}
	want := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC).Unix() // 18:00 JST
	if m.NextAiring == nil || m.NextAiring.Episode != 2 || m.NextAiring.AiringAt != want || len(m.Schedule) != 2 || m.Schedule[1].Episode != 3 {
		t.Fatalf("next airing %+v, want episode 2 at %d", m.NextAiring, want)
	}
	// Chinese animation TVDB files under "Animation" only is anime as AniList
	// counts it; western animation is not
	var donghua, western seriesRecord
	json.Unmarshal([]byte(`{"originalCountry": "chn", "genres": [{"name": "Animation"}, {"name": "Fantasy"}]}`), &donghua)
	json.Unmarshal([]byte(`{"originalCountry": "usa", "genres": [{"name": "Animation"}]}`), &western)
	var dg, wm anilist.Media
	donghua.enrich(&dg, time.Now())
	western.enrich(&wm, time.Now())
	if !slices.Contains(dg.Genres, "Anime") || slices.Contains(wm.Genres, "Anime") {
		t.Errorf("donghua %v, western %v", dg.Genres, wm.Genres)
	}
	// a finished show has no next episode
	var done seriesRecord
	json.Unmarshal([]byte(`{"episodes": [{"seasonNumber": 1, "number": 1, "aired": "2002-04-03"}]}`), &done)
	var dm anilist.Media
	done.enrich(&dm, time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC))
	if dm.NextAiring != nil || dm.Episodes != 1 {
		t.Errorf("finished: %+v", dm)
	}
}
