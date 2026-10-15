package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A folder mounted here under another prefix is reported to the server under
// the path the server knows, or it scans nothing.
func TestRescanNamesTheServerPath(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/System/Info/Public":
			json.NewEncoder(w).Encode(map[string]string{"Id": "new-server"})
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

	// what was cached about the previous server goes once another one answers
	db.SetSetting(d, "media_server_id", "old-server")
	db.SetSetting(d, "media_server_kind", "plex")
	d.Exec(`INSERT INTO users (id, email) VALUES (1, 'chisato@da.jp')`)
	d.Exec(`INSERT INTO plex_accounts (user_id, token_enc) VALUES (1, 'x')`)
	s.cacheSet("plex:machineid:jellyfin", "old-server")
	s.cacheSet("plex:guididx:v3", "{}")
	s.refreshPlexRoots()
	for _, k := range []string{"plex:machineid:jellyfin", "plex:guididx:v3"} {
		if _, ok := s.cacheGet(k, time.Hour); ok {
			t.Errorf("%s survived the server change", k)
		}
	}
	if db.Setting(d, "media_server_id") != "new-server" || db.Setting(d, "media_server_kind") != "jellyfin" {
		t.Error("new server not remembered")
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM plex_accounts`).Scan(&n)
	if n != 0 {
		t.Error("a plex.tv watchlist link must not carry over to Jellyfin")
	}
}
