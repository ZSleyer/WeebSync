package tvdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A translation call that fails (5xx, rate limit) is not "no translation": the
// record built without it must not be cached, or a finished series keeps the
// Japanese title for good.
func TestTranslationFailureIsNotCached(t *testing.T) {
	fail := true
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok"}}`))
	})
	mux.HandleFunc("/series/1/extended", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"id":1,"name":"名探偵コナン","overview":"日本語","status":{"name":"Ended"}}}`))
	})
	mux.HandleFunc("/movies/5/extended", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"id":5,"name":"映画"}}`))
	})
	tr := func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, "busy", http.StatusTooManyRequests)
			return
		}
		w.Write([]byte(`{"data":{"name":"Detektiv Conan","overview":"Deutsch"}}`))
	}
	mux.HandleFunc("/series/1/translations/", tr)
	mux.HandleFunc("/movies/5/translations/", tr)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")
	c := New(dbtest.Open(t))
	ctx := context.Background()

	if _, err := c.Media(ctx, 1); err == nil {
		t.Fatal("Media: want an error while translations fail")
	}
	if m, _ := c.CachedMedia(1); m != nil {
		t.Fatalf("Media cached a degraded record: %+v", m)
	}
	if _, err := c.Movie(ctx, 5); err == nil {
		t.Fatal("Movie: want an error while translations fail")
	}
	if m, _ := c.CachedMovie(5); m != nil {
		t.Fatalf("Movie cached a degraded record: %+v", m)
	}
	if _, err := c.SeriesTitle(ctx, 1, "de"); err == nil {
		t.Fatal("SeriesTitle: want an error while translations fail")
	}
	if _, ok := c.cached("tvdb:title:1:de"); ok {
		t.Fatal("SeriesTitle cached a fallback name")
	}

	fail = false
	m, err := c.Media(ctx, 1)
	if err != nil || m.Title.Romaji != "Detektiv Conan" {
		t.Fatalf("after recovery: %+v %v", m, err)
	}
}
