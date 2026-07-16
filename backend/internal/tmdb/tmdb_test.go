package tmdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// synthetic fixtures only
func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/search/tv", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test.jwt.token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"results":[{"id":42,"name":"Beispielserie","original_name":"Example Show",
			"first_air_date":"2020-01-05","poster_path":"/p.jpg","overview":"Eine Serie."}]}`))
	})
	mux.HandleFunc("/tv/42", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":42,"name":"Beispielserie","original_name":"Example Show",
			"first_air_date":"2020-01-05","poster_path":"/p.jpg","backdrop_path":"/b.jpg",
			"overview":"Eine Serie.","status":"Returning Series","number_of_episodes":20,
			"vote_average":7.5,"genres":[{"name":"Drama"}],
			"next_episode_to_air":{"air_date":"2030-05-01","episode_number":3},
			"videos":{"results":[{"key":"yt123","site":"YouTube","type":"Trailer"}]}}`))
	})
	mux.HandleFunc("/movie/7", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":7,"title":"Beispielfilm","release_date":"2019-06-01",
			"belongs_to_collection":{"id":99}}`))
	})
	mux.HandleFunc("/collection/99", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"parts":[
			{"id":8,"title":"Beispielfilm 2","release_date":"2021-06-01"},
			{"id":7,"title":"Beispielfilm","release_date":"2019-06-01"},
			{"id":9,"title":"Beispielfilm 3","release_date":"2099-01-01"},
			{"id":10,"title":"Unangekündigt","release_date":""}]}`))
	})
	return httptest.NewServer(mux)
}

func TestMovieCollection(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	db.SetSetting(d, "tmdb_api_key", "test.jwt.token")
	srv := testServer(t)
	defer srv.Close()
	c := New(d)
	c.BaseURL = srv.URL

	collID, err := c.MovieCollection(context.Background(), 7)
	if err != nil || collID != 99 {
		t.Fatalf("collection id: %d %v", collID, err)
	}
	parts, err := c.Collection(context.Background(), 99)
	if err != nil {
		t.Fatal(err)
	}
	// unreleased and undated parts are skipped, remainder sorted by year
	if len(parts) != 2 || parts[0].ID != 7 || parts[1].ID != 8 {
		t.Errorf("parts: %+v", parts)
	}
	// cached: works with the server gone
	srv.Close()
	if id, err := c.MovieCollection(context.Background(), 7); err != nil || id != 99 {
		t.Errorf("cached collection id: %d %v", id, err)
	}
}

func TestClient(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	db.SetSetting(d, "tmdb_api_key", "test.jwt.token") // JWT → bearer header
	srv := testServer(t)
	defer srv.Close()
	c := New(d)
	c.BaseURL = srv.URL

	list, err := c.Search(context.Background(), "tv", "beispiel", 0)
	if err != nil || len(list) != 1 {
		t.Fatalf("search: %v %v", list, err)
	}
	if list[0].Title.Romaji != "Beispielserie" || list[0].Title.English != "Example Show" ||
		list[0].SeasonYear != 2020 || list[0].CoverImage.Large != c.Images+"/w500/p.jpg" {
		t.Errorf("mapping: %+v", list[0])
	}

	m, err := c.Media(context.Background(), "tv", 42)
	if err != nil {
		t.Fatal(err)
	}
	if m.Status != "RELEASING" || m.Episodes != 20 || m.AverageScore != 75 {
		t.Errorf("detail: status=%s eps=%d score=%d", m.Status, m.Episodes, m.AverageScore)
	}
	if m.NextAiring == nil || m.NextAiring.Episode != 21 {
		t.Errorf("nextAiring: %+v", m.NextAiring)
	}
	if m.Trailer == nil || m.Trailer.ID != "yt123" || m.Trailer.Site != "youtube" {
		t.Errorf("trailer: %+v", m.Trailer)
	}
	// cached: second call works even with the server gone
	srv.Close()
	if got, fresh := c.CachedMedia("tv", 42); got == nil || !fresh {
		t.Error("cache miss after fetch")
	}
}

func TestStatusMap(t *testing.T) {
	cases := map[string]string{
		"Returning Series": "RELEASING",
		"Ended":            "FINISHED",
		"Released":         "FINISHED",
		"Canceled":         "CANCELLED",
		"In Production":    "NOT_YET_RELEASED",
	}
	for in, want := range cases {
		if got := statusMap(in); got != want {
			t.Errorf("%s: got %s", in, got)
		}
	}
}
