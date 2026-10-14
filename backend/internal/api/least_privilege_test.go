package api

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// What reaches the shared library, the admin's Plex or the instance's
// settings is an admin's, whatever the UI shows: a signed-in non-admin is
// refused by the server, the admin is not.
func TestSharedResourcesAreAdmins(t *testing.T) {
	mux, s, adminC, userC, _, userID := setupUsersTest(t)

	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/rename/apply", `{"path":"/x","renames":[{"old":"a.mkv","new":"b.mkv"}]}`},
		{"GET", "/api/plex/me", ""},
		{"GET", "/api/plex/sections", ""},
		{"PUT", "/api/watches/1/plex-show", `{"ratingKey":"1"}`},
		{"POST", "/api/watches/1/plex-streams", ""},
		{"PUT", "/api/servers/0/catalog/match", `{"folder":"/x","mediaId":1}`},
		{"POST", "/api/servers/0/catalog/rematch", `{"path":"","all":true}`},
		{"PUT", "/api/servers/0/catalog/scope", `{"path":"","kind":"anilist"}`},
	} {
		if rec := doReq(mux, tc.method, tc.path, tc.body, userC); rec.Code != http.StatusForbidden {
			t.Errorf("non-admin %s %s: got %d, want 403: %s", tc.method, tc.path, rec.Code, rec.Body)
		}
	}
	// the admin gets past the guard (whatever the handler then says)
	if rec := doReq(mux, "PUT", "/api/servers/0/catalog/scope", `{"path":"","kind":"anilist"}`, adminC); rec.Code == http.StatusForbidden {
		t.Errorf("admin refused the local catalog: %s", rec.Body)
	}

	// a rule on the local library survives a non-admin's delete
	res, err := s.DB.Exec(`INSERT INTO catalog_scope_rules (server_id, parent, shape, kind) VALUES (0, '/anime', '*', 'anime')`)
	if err != nil {
		t.Fatal(err)
	}
	ruleID, _ := res.LastInsertId()
	doReq(mux, "DELETE", "/api/catalog/scope-rules/"+strconv.FormatInt(ruleID, 10), "", userC)
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_scope_rules WHERE id = ?`, ruleID).Scan(&n)
	if n != 1 {
		t.Error("a non-admin deleted a rule on the local library")
	}

	// the legacy import does not set the instance's interval for a non-admin
	db.SetSetting(s.DB, "watch_interval_min", "60")
	s.DB.Exec(`INSERT INTO servers (id, user_id, name, host, port, username, protocol, secret_enc) VALUES (7, ?, 'mine', 'example.com', 22, 'u', 'sftp', x'00')`, userID)
	doReq(mux, "POST", "/api/import/legacy", `{"serverId":7,"intervalMin":1440,"watches":[]}`, userC)
	if v := db.Setting(s.DB, "watch_interval_min"); v != "60" {
		t.Errorf("non-admin changed the sync interval to %s", v)
	}

	// Plex tracks in a non-admin's defaults are dropped
	doReq(mux, "PUT", "/api/auth/watch-defaults", `{"kinds":{},"common":{"plexAudioLang":"Ger","plexSubLang":"off"}}`, userC)
	rec := doReq(mux, "GET", "/api/auth/watch-defaults", "", userC)
	if body := rec.Body.String(); strings.Contains(body, `"plexAudioLang":"Ger"`) {
		t.Errorf("non-admin stored Plex tracks: %s", body)
	}
}
