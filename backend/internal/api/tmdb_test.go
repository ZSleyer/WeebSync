package api

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

func TestScopeForAndHandler(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Tmdb: tmdb.New(d)}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookie := cookieForUser(t, d, 1)

	// no TMDB key configured: marking is rejected (feature stays optional)
	if rec := doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/x/Serien","kind":"tv"}`, cookie); rec.Code != http.StatusBadRequest {
		t.Errorf("scope without key: got %d, want 400", rec.Code)
	}
	db.SetSetting(d, "tmdb_api_key", "test-key")
	if rec := doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/x/Serien","kind":"tv"}`, cookie); rec.Code != http.StatusOK {
		t.Fatalf("scope set: got %d: %s", rec.Code, rec.Body)
	}
	doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/x/Serien/Filmordner","kind":"movie"}`, cookie)

	// inheritance: deepest mark wins, unrelated paths stay anime
	cases := map[string]string{
		"/x/Serien":                     "tv",
		"/x/Serien/Breaking Example":    "tv",
		"/x/Serien/Filmordner/Ein Film": "movie",
		"/x/SerienNicht":                "", // no false prefix match
		"/x/Anderes":                    "",
	}
	for p, want := range cases {
		if got := s.scopeFor(1, p); got != want {
			t.Errorf("scopeFor(%q) = %q, want %q", p, got, want)
		}
	}

	// clearing restores inheritance from above
	doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/x/Serien/Filmordner","kind":""}`, cookie)
	if got := s.scopeFor(1, "/x/Serien/Filmordner/Ein Film"); got != "tv" {
		t.Errorf("after clear: got %q, want tv", got)
	}

	// foreign user cannot mark
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('b@example.com', 0)`)
	cookieB := cookieForUser(t, d, 2)
	if rec := doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/y","kind":"tv"}`, cookieB); rec.Code != http.StatusNotFound {
		t.Errorf("foreign scope: got %d, want 404", rec.Code)
	}

	if sourceForScope("") != "anilist" || sourceForScope("tv") != "tmdb:tv" {
		t.Error("sourceForScope mapping")
	}
}

// A film inside a tv library is matched against films, so its match row carries
// the movie source. The manual correction has to store that same tag - storing
// the library's tv tag made the listing treat the row as foreign and replace it
// with a fresh automatic match, which is how corrections used to vanish.
func TestManualMatchSourceFollowsFilmKind(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, Tmdb: tmdb.New(d)}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookie := cookieForUser(t, d, 1)
	db.SetSetting(d, "tmdb_api_key", "test-key")
	doReq(mux, "PUT", "/api/servers/1/catalog/scope", `{"path":"/lib","kind":"tv"}`, cookie)

	// one video file and no subfolders: the film in an otherwise tv library
	d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir)
		VALUES (1, '/lib/Ein Film/film.mkv', '/lib/Ein Film', 'film.mkv', 0)`)
	// several episodes: an ordinary show in the same library
	d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir)
		VALUES (1, '/lib/Serie/s01e01.mkv', '/lib/Serie', 's01e01.mkv', 0),
		       (1, '/lib/Serie/s01e02.mkv', '/lib/Serie', 's01e02.mkv', 0)`)

	for folder, want := range map[string]string{"/lib/Ein Film": "tmdb:movie", "/lib/Serie": "tmdb:tv"} {
		body := `{"folder":"` + folder + `","mediaId":42}`
		if rec := doReq(mux, "PUT", "/api/servers/1/catalog/match", body, cookie); rec.Code != http.StatusOK {
			t.Fatalf("match %s: got %d: %s", folder, rec.Code, rec.Body)
		}
		var got string
		d.QueryRow(`SELECT source FROM catalog_matches WHERE server_id = 1 AND folder = ?`, folder).Scan(&got)
		if got != want {
			t.Errorf("stored source for %q = %q, want %q", folder, got, want)
		}
	}
}
