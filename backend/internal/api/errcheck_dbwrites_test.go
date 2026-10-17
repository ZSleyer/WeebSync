package api

import (
	"net/http"
	"testing"
)

// failWrites makes every write of the kind on the table abort, the way a full
// disk or a locked database would, so a handler that ignored the result is
// caught answering ok.
func failWrites(t *testing.T, s *Server, event, table string) {
	t.Helper()
	if _, err := s.DB.Exec(`CREATE TRIGGER fail_` + event + `_` + table + ` BEFORE ` + event + ` ON ` + table +
		` BEGIN SELECT RAISE(ABORT, 'disk full'); END`); err != nil {
		t.Fatal(err)
	}
}

func TestAdminSettingsWritesReportFailure(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)
	failWrites(t, s, "INSERT", "settings")
	failWrites(t, s, "UPDATE", "settings")
	if rec := doReq(mux, "PUT", "/api/admin/ttl", `{"anilistH":1,"tmdbH":2,"plexH":3}`, adminC); rec.Code != http.StatusInternalServerError {
		t.Errorf("ttl: got %d, want 500: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/admin/index/1/config", `{"intervalMin":5,"batch":10}`, adminC); rec.Code != http.StatusInternalServerError {
		t.Errorf("index config: got %d, want 500: %s", rec.Code, rec.Body)
	}
}

func TestAnilistPermissionsWriteReportsFailure(t *testing.T) {
	mux, s, adminC, _ := setupAdminTest(t)
	failWrites(t, s, "UPDATE", "users")
	if rec := doReq(mux, "PUT", "/api/anilist/permissions", `{"list":true}`, adminC); rec.Code != http.StatusInternalServerError {
		t.Errorf("permissions: got %d, want 500: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "DELETE", "/api/anilist/connect", "", adminC); rec.Code != http.StatusInternalServerError {
		t.Errorf("disconnect: got %d, want 500 (the write switches must not stay on): %s", rec.Code, rec.Body)
	}
}

// A database error while checking who owns the server is not "server not
// found".
func TestServerOwnershipReadFailureIsNot404(t *testing.T) {
	mux, s, _, userC := setupAdminTest(t)
	if _, err := s.DB.Exec(`ALTER TABLE servers RENAME COLUMN user_id TO owner_id`); err != nil {
		t.Fatal(err)
	}
	for _, rt := range []struct{ method, path, body string }{
		{"GET", "/api/servers/1/search?q=x", ""},
		{"GET", "/api/servers/1/languages", ""},
		{"PUT", "/api/servers/1/catalog/match", `{"folder":"/x","mediaId":1}`},
	} {
		if rec := doReq(mux, rt.method, rt.path, rt.body, userC); rec.Code != http.StatusInternalServerError {
			t.Errorf("%s %s: got %d, want 500: %s", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
}

func TestHashLegacyVerifyTokensOnce(t *testing.T) {
	_, s, _, _ := setupAdminTest(t)
	// Register already ran it once on the empty database
	if _, err := s.DB.Exec(`DELETE FROM settings WHERE key = 'verify_tokens_hashed_v1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`UPDATE users SET verify_token = 'plain' WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	s.hashLegacyVerifyTokens()
	s.hashLegacyVerifyTokens() // the flag is set with the hashes: a second run must not hash the hashes
	var tok string
	if err := s.DB.QueryRow(`SELECT verify_token FROM users WHERE id = 2`).Scan(&tok); err != nil {
		t.Fatal(err)
	}
	if tok != hashToken("plain") {
		t.Errorf("token = %q, want the single hash", tok)
	}
	var flag string
	if err := s.DB.QueryRow(`SELECT value FROM settings WHERE key = 'verify_tokens_hashed_v1'`).Scan(&flag); err != nil || flag != "1" {
		t.Errorf("flag = %q, %v", flag, err)
	}
}
