package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/tmdb"
)

// An AniList title the id mapping knows gets its widest TMDB backdrop, in both
// sizes; one it does not know, or with only small backdrops, keeps its own
// banner (an empty answer).
func TestMediaBackdropFromTheMappedTMDBEntry(t *testing.T) {
	mux, s, _, userC, _, _ := setupUsersTest(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 21's title has a small and a large backdrop, 22's only a small one
		if r.URL.Path == "/tv/37854/images" {
			w.Write([]byte(`{"backdrops":[{"file_path":"/small.jpg","width":512,"iso_639_1":null},{"file_path":"/bd.jpg","width":3840,"iso_639_1":null}]}`))
			return
		}
		w.Write([]byte(`{"backdrops":[{"file_path":"/tiny.jpg","width":780,"iso_639_1":null}]}`))
	}))
	defer fake.Close()
	t.Setenv("TMDB_API_KEY", "k")
	s.Tmdb = tmdb.New(s.DB)
	s.Tmdb.BaseURL = fake.URL
	s.Tmdb.HTTP = fake.Client()
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season, imdb_id)
		VALUES (21, 0, 0, 37854, 'tv', 0, ''), (22, 0, 0, 999, 'tv', 0, '')`)

	get := func(id string) backdropResponse {
		var out backdropResponse
		rec := doReq(mux, "GET", "/api/media/backdrop?id="+id, "", userC)
		if rec.Code != http.StatusOK {
			t.Fatalf("id %s: %d %s", id, rec.Code, rec.Body)
		}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	got := get("21")
	if got.URL != "https://image.tmdb.org/t/p/w1280/bd.jpg" || got.Large != "https://image.tmdb.org/t/p/original/bd.jpg" {
		t.Errorf("mapped: %+v", got)
	}
	if got := get("99"); got.URL != "" || got.Large != "" {
		t.Errorf("unmapped: %+v, want empty", got)
	}
	if got := get("22"); got.URL != "" {
		t.Errorf("only a small backdrop: %+v, want AniList's banner kept", got)
	}
	if rec := doReq(mux, "GET", "/api/media/backdrop?id=21&source=tvdb", "", userC); rec.Code != http.StatusBadRequest {
		t.Errorf("other source: %d, want 400", rec.Code)
	}
}

// A TMDB failure is not "no better picture": answering an empty 200 lets the
// page keep that for a day. It has to be an error the client can retry.
func TestMediaBackdropProviderFailureIsAnError(t *testing.T) {
	mux, s, _, userC, _, _ := setupUsersTest(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer fake.Close()
	t.Setenv("TMDB_API_KEY", "k")
	s.Tmdb = tmdb.New(s.DB)
	s.Tmdb.BaseURL = fake.URL
	s.Tmdb.HTTP = fake.Client()
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season, imdb_id)
		VALUES (31, 0, 0, 4242, 'tv', 0, '')`)
	rec := doReq(mux, "GET", "/api/media/backdrop?id=31", "", userC)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("provider failure: %d %s, want 502", rec.Code, rec.Body)
	}
}
