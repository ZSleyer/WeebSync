package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A folder mounted here under another prefix is reported to the server under
// the path the server knows, or it scans nothing.
func TestRescanNamesTheServerPath(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/Library/VirtualFolders":
			json.NewEncoder(w).Encode([]map[string]any{{"Name": "Anime", "ItemId": "lib1",
				"CollectionType": "tvshows", "Locations": []string{"/media/anime"}}})
		case "/Library/Media/Updated":
			var in struct{ Updates []struct{ Path string } }
			json.NewDecoder(r.Body).Decode(&in)
			if len(in.Updates) == 1 {
				got = in.Updates[0].Path
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	d := dbtest.Open(t)
	s := &Server{DB: d}
	db.SetSetting(d, "jellyfin_url", srv.URL)
	db.SetSetting(d, "jellyfin_token", "key")
	db.SetSetting(d, "plex_roots", "/media/anime => /mnt/a/anime")
	db.SetSetting(d, "plex_lib_map", "/mnt/a/anime\tAnime")
	s.plexRescan("/mnt/a/anime/Show/Season 01")
	if got != "/media/anime/Show/Season 01" {
		t.Fatalf("server was told %q", got)
	}
}
