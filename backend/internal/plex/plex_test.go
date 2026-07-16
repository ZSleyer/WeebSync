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
			{"key":"1","type":"show","title":"Anime"},
			{"key":"2","type":"movie","title":"Movies"}]}}`))
	})
	mux.HandleFunc("/library/sections/1/all", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"10","title":"Example Show","year":2024,"leafCount":12,"childCount":1}]}}`))
	})
	mux.HandleFunc("/library/metadata/10", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"MediaContainer":{"Metadata":[
			{"ratingKey":"10","title":"Example Show","originalTitle":"例のショー","year":2024,"leafCount":12,
			 "Location":[{"path":"/media/plex/series/Example_Show"}]}]}}`))
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
	c.Token = "wrong"
	if _, err := c.Sections(); err == nil {
		t.Error("expected auth error")
	}
}
