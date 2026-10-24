package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

// A hint dismissed while the provider lookups of a forced re-match are still
// running must stay dismissed.
func TestHintFolderKeepsDismissalMadeDuringLookup(t *testing.T) {
	d := dbtest.Open(t)
	if err := db.SetSetting(d, "tmdb_api_key", "test.jwt.token"); err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO users (id, email) VALUES (1,'u@e.test')`)
	d.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (1,1,'s','sftp','h',22,'u',x'00')`)
	folder := "/Area/Neo Yokio [EngDub,NF]"
	d.Exec(`INSERT INTO match_hints (server_id, folder, state, source, media_id, title, year, checked_at)
		VALUES (1, ?, 'hint', 'tmdb:tv', 11, 'Neo Yokio', 2017, 1)`, folder)

	mux := http.NewServeMux()
	mux.HandleFunc("/search/tv", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":11,"name":"Neo Yokio","original_name":"Neo Yokio","first_air_date":"2017-09-22","poster_path":"/n.jpg","overview":"x","vote_count":300}]}`))
	})
	mux.HandleFunc("/search/movie", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	})
	mux.HandleFunc("/tv/11", func(w http.ResponseWriter, r *http.Request) {
		// the user clicks "dismiss" while the lookup is in flight
		d.Exec(`UPDATE match_hints SET state = 'dismissed' WHERE server_id = 1 AND folder = ?`, folder)
		w.Write([]byte(`{"id":11,"name":"Neo Yokio","original_name":"Neo Yokio","first_air_date":"2017-09-22","poster_path":"/n.jpg","overview":"x","number_of_episodes":6,"seasons":[{"season_number":1,"episode_count":6}]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := tmdb.New(d)
	c.BaseURL = srv.URL
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d), Tmdb: c})

	lookup(t, s, folder, true)

	var state string
	if err := d.QueryRow(`SELECT state FROM match_hints WHERE server_id = 1 AND folder = ?`, folder).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "dismissed" {
		t.Errorf("state = %q, want dismissed", state)
	}
}
