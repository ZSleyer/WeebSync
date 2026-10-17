package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A mapping that cannot be written must not read as applied: an admin the
// provider demoted would stay an admin while the login went through.
func TestOIDCAdminSyncWriteFailure(t *testing.T) {
	d := dbtest.Open(t)
	yes, no := true, false
	if _, err := findOrCreateOIDCUser(d, "first@example.com", &yes, true); err != nil {
		t.Fatal(err)
	}
	if _, err := findOrCreateOIDCUser(d, "second@example.com", &yes, true); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`CREATE TRIGGER no_admin_write BEFORE UPDATE OF is_admin ON users
		BEGIN SELECT RAISE(ABORT, 'disk full'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := findOrCreateOIDCUser(d, "second@example.com", &no, true); err == nil {
		t.Fatal("demotion that could not be stored was reported as done")
	}
}

// Logout has to say so when the session row survives: the cookie is gone,
// but the token would still open the account.
func TestDestroySessionReportsFailure(t *testing.T) {
	d := dbtest.Open(t)
	id, err := findOrCreateOIDCUser(d, "a@example.com", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, '2999-01-01T00:00:00Z')`, hashToken("tok"), id); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`CREATE TRIGGER keep_sessions BEFORE DELETE ON sessions
		BEGIN SELECT RAISE(ABORT, 'locked'); END`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	r.AddCookie(&http.Cookie{Name: "weebsync_session", Value: "tok"})
	w := httptest.NewRecorder()
	if err := DestroySession(d, w, r); err == nil {
		t.Fatal("a session that was not deleted was reported as destroyed")
	}
	if len(w.Result().Cookies()) == 0 {
		t.Error("cookie not cleared")
	}
}

func TestAuthModeErrReportsReadFailure(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO settings (key, value) VALUES ('auth_mode', 'oidc-only')`)
	if m, err := AuthModeErr(d); err != nil || m != "oidc-only" {
		t.Fatalf("%q, %v", m, err)
	}
	d.Exec(`DELETE FROM settings`)
	if m, err := AuthModeErr(d); err != nil || m != "password" {
		t.Fatalf("unset: %q, %v", m, err)
	}
	d.Exec(`DROP TABLE settings`)
	if _, err := AuthModeErr(d); err == nil {
		t.Fatal("a failed read was reported as the default mode")
	}
}
