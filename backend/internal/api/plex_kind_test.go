package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// fakePlexFargo holds the series "Fargo" and, in a library read later, the
// unrelated film of the same title. Their ids differ, their folded titles do
// not.
func fakePlexFargo(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all":
			w.Write([]byte(`{"MediaContainer":{"Directory":[
				{"key":"1","type":"show","title":"Serien"},
				{"key":"2","type":"movie","title":"Filme"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/1/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"10","title":"Fargo",
				"year":2014,"Guid":[{"id":"tvdb://269613"},{"id":"tmdb://60622"}]}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/2/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"20","title":"Fargo",
				"year":1996,"Guid":[{"id":"tmdb://275"},{"id":"imdb://tt0116282"}]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func plexKindServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	srv := fakePlexFargo(t)
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")
	return s, srv
}

// The film's TMDB id used to come back as the series' match: both landed on
// one title key and the library read last won.
func TestMatchLocalByPlexIDKeepsFilmAndSeriesApart(t *testing.T) {
	s, _ := plexKindServer(t)
	s.plexGuidIndex() // build it, as the sweep does

	if id, ok := s.matchLocalByPlexID("/local/Fargo", "tmdb:tv"); !ok || id != 60622 {
		t.Errorf("tmdb:tv match = %d,%v, want the series 60622", id, ok)
	}
	if id, ok := s.matchLocalByPlexID("/local/Fargo", "tmdb:movie"); !ok || id != 275 {
		t.Errorf("tmdb:movie match = %d,%v, want the film 275", id, ok)
	}
}

// A film's TMDB number names a series too, an unrelated one: it must not be
// looked up as tmdb:tv on the way to an AniList id.
func TestMatchLocalByPlexIDAnilistIgnoresAFilmsTmdbID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/library/sections/all":
			w.Write([]byte(`{"MediaContainer":{"Directory":[{"key":"2","type":"movie","title":"Filme"}]}}`))
		case strings.HasPrefix(r.URL.Path, "/library/sections/2/all"):
			w.Write([]byte(`{"MediaContainer":{"totalSize":1,"Metadata":[{"ratingKey":"5","title":"Akira",
				"year":1988,"Guid":[{"id":"tmdb://149"}]}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")
	s.plexGuidIndex()
	// series 1 is the TV show that happens to carry tmdb 149
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'other','Other')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tmdb:tv',149,1), ('anilist',999,1)`)
	d.Exec(`INSERT INTO anime_ids (anilist_id, tmdb_id, tmdb_kind) VALUES (998, 149, 'tv')`)

	if id, ok := s.matchLocalByPlexID("/local/Akira", "anilist"); ok {
		t.Errorf("a film's tmdb id resolved to the series' AniList id %d", id)
	}
}

// Reconcile hangs the identity of the Plex entry of the folder's own kind on
// its series, and a film's ids under the film catalogue.
func TestReconcilePlexPicksTheEntryOfTheFoldersKind(t *testing.T) {
	s, _ := plexKindServer(t)
	d := s.DB
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'a@example.com')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'fargo','Fargo'), (2,'fargo film','Fargo')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tmdb:tv',60622,1), ('tmdb:movie',275,2)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES
		(1,'/ftp/serien/Fargo',60622,0,'tmdb:tv'), (1,'/ftp/filme/Fargo',275,0,'tmdb:movie')`)

	s.reconcilePlex(10)

	rows := map[string]int64{}
	r, err := d.Query(`SELECT source || ':' || media_id, series_id FROM series_provider`)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for r.Next() {
		var k string
		var id int64
		if err := r.Scan(&k, &id); err != nil {
			t.Fatal(err)
		}
		rows[k] = id
	}
	if err := r.Err(); err != nil {
		t.Fatal(err)
	}
	if rows["plex:10"] != 1 || rows["tvdb:269613"] != 1 {
		t.Errorf("the series did not get the Plex series' identity: %v", rows)
	}
	if rows["plex:20"] != 2 {
		t.Errorf("the film did not get the Plex film's identity: %v", rows)
	}
	if _, ok := rows["tmdb:tv:275"]; ok {
		t.Errorf("the film's TMDB id was filed as a TV id: %v", rows)
	}
}

// A film with TMDB 1234 says nothing about the series tmdb:tv/1234.
func TestPlexOwnedTellsFilmAndSeriesIDsApart(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	s.cacheSet("plex:titleidx:v2", `{}`)
	s.cacheSet(plexGuidKey, `{"movie:somefilm":{"tmdb":1234,"ratingKey":"1","movie":true}}`)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url','http://plex.example.com:32400'), ('plex_token','t')`)

	owned := s.plexOwned()
	if owned(ownMedia(1234, "A Series", "", ""), "tmdb:tv") {
		t.Error("a film's TMDB id hid the series of the same number")
	}
	if !owned(ownMedia(1234, "Some Film", "", ""), "tmdb:movie") {
		t.Error("the film itself is not owned")
	}
}
