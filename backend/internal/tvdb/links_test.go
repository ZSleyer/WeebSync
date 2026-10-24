package tvdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The "Official Site" and "Wikipedia" remote ids are free text written by
// TVDB editors. Only a real http(s) URL may become a link; anything else would
// resolve relative to the app or run as a script URL.
func TestExtrasLinksAreWebURLsOnly(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"token":"tok"}}`))
	})
	mux.HandleFunc("/series/1/extended", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"remoteIds":[
			{"id":"https://example.jp/anime","type":4},
			{"id":"www.example.jp/anime","type":4},
			{"id":"javascript:alert(1)","type":4},
			{"id":"//evil.example/x","type":4},
			{"id":"/relative/path","type":4},
			{"id":"https://ja.wikipedia.org/wiki/X","type":24},
			{"id":"data:text/html,x","type":24},
			{"id":"https:///nohost","type":4},
			{"id":"tt123","type":2}
		]}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "dev-key")
	c := New(dbtest.Open(t))

	x, err := c.Extras(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, l := range x.Links {
		got[l.URL] = true
	}
	want := map[string]bool{
		"https://example.jp/anime":         true,
		"https://ja.wikipedia.org/wiki/X":  true,
		"https://www.imdb.com/title/tt123": true,
	}
	if len(got) != len(want) {
		t.Fatalf("links = %v, want %v", x.Links, want)
	}
	for u := range want {
		if !got[u] {
			t.Errorf("missing link %s in %v", u, x.Links)
		}
	}
}
