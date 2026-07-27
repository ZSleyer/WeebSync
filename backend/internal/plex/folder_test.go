package plex

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// folderServer serves the by-folder view of one section: the library root, a
// show folder holding two seasons, and a season folder holding an episode.
// The show is deliberately titled in another language than its folder - that is
// the case the title route cannot handle.
func folderServer(t *testing.T) *httptest.Server {
	t.Helper()
	routes := map[string]string{
		"/library/sections": `{"MediaContainer":{"Directory":[
			{"key":"3","type":"show","title":"Anime","Location":[{"path":"/media/disk/anime"}]}]}}`,
		"/library/sections/3/prefs": `{"MediaContainer":{"Setting":[]}}`,
		"/library/sections/3/folder": `{"MediaContainer":{"Metadata":[
			{"title":"Another_Show","key":"/library/sections/3/folder?parent=1"},
			{"title":"Daemons_of_the_Shadow_Realm","key":"/library/sections/3/folder?parent=2"}]}}`,
		"/library/sections/3/folder?parent=2": `{"MediaContainer":{"Metadata":[
			{"title":"Season_01","key":"/library/sections/3/folder?parent=3"},
			{"title":"Season_02","key":"/library/sections/3/folder?parent=4"}]}}`,
		"/library/sections/3/folder?parent=3": `{"MediaContainer":{"Metadata":[
			{"ratingKey":"71900","grandparentRatingKey":"71812","title":"Folge 1"}]}}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := routes[r.URL.RequestURI()]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestShowKeyForPathWalksTheFolderView(t *testing.T) {
	srv := folderServer(t)
	c := New(srv.URL, "t")

	// a season folder: one component down from the show, episodes right there
	if got, ok := c.ShowKeyForPath("/media/disk/anime/Daemons_of_the_Shadow_Realm/Season_01"); !ok || got != "71812" {
		t.Errorf("season folder -> %q, %v; want 71812, true", got, ok)
	}
	// the show root: seasons first, so it has to descend to reach an episode
	if got, ok := c.ShowKeyForPath("/media/disk/anime/Daemons_of_the_Shadow_Realm"); !ok || got != "71812" {
		t.Errorf("show folder -> %q, %v; want 71812, true", got, ok)
	}
}

func TestShowKeyForPathGivesUp(t *testing.T) {
	srv := folderServer(t)
	c := New(srv.URL, "t")

	for _, tc := range []struct {
		name string
		path string
	}{
		{"outside every library", "/srv/downloads/Some_Show"},
		{"folder Plex has not scanned", "/media/disk/anime/Not_Scanned_Yet"},
		{"season that does not exist", "/media/disk/anime/Daemons_of_the_Shadow_Realm/Season_09"},
		{"no episode below it", "/media/disk/anime/Daemons_of_the_Shadow_Realm/Season_02"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := c.ShowKeyForPath(tc.path); ok {
				t.Errorf("got %q, true; want no answer rather than a guess", got)
			}
		})
	}
}
