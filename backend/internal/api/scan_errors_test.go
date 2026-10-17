package api

import (
	"net/http"
	"testing"
)

// A row the driver cannot read is a database error, not a zeroed or skipped
// row. SQLite keeps text in an INTEGER column, which fails the int scan.

func TestWebAuthnListReportsAScanError(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	if _, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, replace_due)
		VALUES (?, x'01', x'7b7d', 'key', 'x')`, userID); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "GET", "/api/auth/webauthn/credentials", "", userC); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500: %s", rec.Code, rec.Body)
	}
}

func TestServerSearchReportsAScanError(t *testing.T) {
	mux, s, adminC, _, adminID, _ := setupUsersTest(t)
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (?, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`, adminID)
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := res.LastInsertId()
	if _, err := s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir, size)
		VALUES (?, '/x/Show', '/x', 'Show', 0, 'x')`, srv); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=show", "", adminC); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500: %s", rec.Code, rec.Body)
	}
}
