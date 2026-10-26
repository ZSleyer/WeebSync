package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A season whose pseudo folder an earlier index wrote is dropped once a
// complete run no longer writes it (its file became reachable, or the show
// left Plex). A stale pseudo row stays a second local copy without a path
// note, so its upgrade card asks an admin to map a path that already works.
func TestPlexIndexDropsStalePseudoFolders(t *testing.T) {
	plexSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all" || r.URL.Path == "/library/sections":
			w.Write([]byte(`{"MediaContainer":{"Directory":[{"key":"3","type":"show","title":"Anime"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/3/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"7","title":"Dragon Ball",
				"Guid":[{"id":"tvdb://76666"}]}]}}`))
		case r.URL.Path == "/library/metadata/7/allLeaves":
			w.Write([]byte(`{"MediaContainer":{"Metadata":[{"parentIndex":1,"Media":[{"videoResolution":"480",
				"Part":[{"file":"/nowhere/Dragon Ball/S01E01.mkv"}]}]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(plexSrv.Close)

	d := dbtest.Open(t)
	s := &Server{DB: d, DownloadRoot: t.TempDir()}
	d.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url', ?), ('plex_token', 'tok')`, plexSrv.URL)
	for _, f := range []string{"plex:1:s1", "/media/Anime/Dragon Ball/Season 01"} {
		if _, err := d.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, computed_at)
			VALUES (0, ?, 480, 'tvdb:76666', 1, '2020-01-01T00:00:00Z')`, f); err != nil {
			t.Fatal(err)
		}
	}

	s.indexPlexLibrary(t.Context())

	have := map[string]bool{}
	rows, err := d.Query(`SELECT folder FROM catalog_variants WHERE server_id = 0`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			t.Fatal(err)
		}
		have[f] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if have["plex:1:s1"] {
		t.Error("stale pseudo folder survived a complete index")
	}
	if !have["plex:7:s1"] {
		t.Error("the season this run indexed is missing")
	}
	if !have["/media/Anime/Dragon Ball/Season 01"] {
		t.Error("a real local folder was dropped: it can come from the local catalog")
	}
}
