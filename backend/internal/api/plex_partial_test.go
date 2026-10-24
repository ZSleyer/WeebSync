package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// fakePlexLibrary is a Plex server with an anime show library whose listing
// fails (a scan in progress, a timeout) and a film library that answers.
func fakePlexLibrary(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all":
			w.Write([]byte(`{"MediaContainer":{"Directory":[
				{"key":"1","type":"show","title":"Anime"},
				{"key":"2","type":"movie","title":"Filme"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/1/all"):
			http.Error(w, "busy", http.StatusInternalServerError)
		case strings.HasPrefix(r.URL.Path, "/library/sections/2/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"7","title":"The Matrix",
				"year":1999,"Guid":[{"id":"tmdb://603"}]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// One library failing used to be cached as the whole library: the films
// alone counted as a complete index, and the reconcile pass then marked every
// anime folder as "Plex has no such show" for good.
func TestPlexPartialLibraryIsNotACompleteIndex(t *testing.T) {
	srv := fakePlexLibrary(t)
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'a@example.com')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'frieren','Frieren')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb',424536,1)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1,'/ftp/Frieren',424536,0,'tvdb')`)

	s.reconcilePlex(10)
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM plex_reconciled`).Scan(&n)
	if n != 0 {
		t.Error("a folder was marked as reconciled against a library that could only be read in part")
	}
	if _, ok := s.cacheGet(plexGuidKey, time.Hour); ok {
		t.Error("the partial guid index was cached as complete")
	}

	c := s.plexClient()
	if _, ok := buildPlexTitleIndex(c); ok {
		t.Error("the partial title index reported success")
	}
	s.plexShowList(c)
	if _, ok := s.cacheGet("plex:showlist:v1", time.Hour); ok {
		t.Error("the partial show list was cached for an hour")
	}
}
