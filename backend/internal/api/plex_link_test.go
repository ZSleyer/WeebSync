package api

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// linkFixture wires a server whose Plex is a stub holding one show, plus a watch
// matched to a series that carries no plex row of its own.
func linkFixture(t *testing.T) (*sql.DB, *http.ServeMux, *http.Cookie) {
	t.Helper()
	plexSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/library/metadata/62755"):
			w.Write([]byte(`{"MediaContainer":{"Metadata":[{"ratingKey":"62755","title":"Re:ZERO",
				"year":2016,"Guid":[{"id":"tvdb://305089"}]}]}}`))
		case r.URL.Path == "/library/sections":
			w.Write([]byte(`{"MediaContainer":{"Directory":[{"key":"3","type":"show","title":"Animeserien"}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(plexSrv.Close)

	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, t.TempDir())}
	mux := http.NewServeMux()
	s.Register(mux)

	d.Exec(`INSERT INTO settings (key, value) VALUES ('plex_url', ?), ('plex_token', 'tok')`, plexSrv.URL)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1,'srv','sftp','localhost',22,'u',X'00','/')`)
	d.Exec(`INSERT INTO watches (id, user_id, server_id, remote_path, local_path)
		VALUES (1,1,1,'/ftp/ReZero S4','anime/ReZero')`)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (1,'rezero','Re:ZERO')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',108632,1)`)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (1,'/ftp/ReZero S4',108632,0,'anilist')`)
	return d, mux, cookieForUser(t, d, 1)
}

func linkPUT(t *testing.T, mux *http.ServeMux, ck *http.Cookie, body string) int {
	t.Helper()
	req := httptest.NewRequest("PUT", "/api/watches/1/plex-show", strings.NewReader(body))
	req.AddCookie(ck)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Code
}

func TestWatchPlexShowLink(t *testing.T) {
	d, mux, ck := linkFixture(t)

	if code := linkPUT(t, mux, ck, `{"ratingKey":"62755"}`); code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204", code)
	}
	var rk, manual int
	if err := d.QueryRow(`SELECT media_id, manual FROM series_provider WHERE series_id = 1 AND source = 'plex'`).
		Scan(&rk, &manual); err != nil {
		t.Fatalf("no plex row was written: %v", err)
	}
	if rk != 62755 || manual != 1 {
		t.Errorf("row = (%d, manual %d), want (62755, manual 1)", rk, manual)
	}
	// the show's own ids come along, so the series is addressable either way
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id = 1 AND source = 'tvdb' AND media_id = 305089`).Scan(&n)
	if n != 1 {
		t.Error("the show's tvdb id was not attached to the series")
	}

	// an empty key hands the series back to the automatic routes
	if code := linkPUT(t, mux, ck, `{"ratingKey":""}`); code != http.StatusNoContent {
		t.Fatalf("clearing PUT = %d, want 204", code)
	}
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id = 1 AND source = 'plex'`).Scan(&n)
	if n != 0 {
		t.Error("the link is still there after clearing it")
	}
}

// Binding a show two series claim would be a silent no-op through the primary
// key, so say it instead.
func TestWatchPlexShowLinkRejectsAClaimedShow(t *testing.T) {
	d, mux, ck := linkFixture(t)
	d.Exec(`INSERT INTO series (id, key, title) VALUES (2,'other','Other')`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id, manual) VALUES ('plex',62755,2,0), ('plex',999,1,1)`)

	if code := linkPUT(t, mux, ck, `{"ratingKey":"62755"}`); code != http.StatusConflict {
		t.Errorf("PUT = %d, want 409", code)
	}
	// a rejected request must leave the binding it had alone
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id = 1 AND source = 'plex' AND media_id = 999`).Scan(&n)
	if n != 1 {
		t.Error("the previous link was dropped by a request that then failed")
	}
}

func TestWatchPlexShowLinkNeedsASeries(t *testing.T) {
	d, mux, ck := linkFixture(t)
	d.Exec(`DELETE FROM catalog_matches`)

	if code := linkPUT(t, mux, ck, `{"ratingKey":"62755"}`); code != http.StatusNotFound {
		t.Errorf("PUT = %d, want 404", code)
	}
}
