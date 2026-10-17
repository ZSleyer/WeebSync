package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/totp"
)

// refuseWrites makes every matching write fail the way a broken database
// would, without touching the read side.
func refuseWrites(t *testing.T, s *Server, name, event string) {
	t.Helper()
	if _, err := s.DB.Exec(`CREATE TRIGGER ` + name + ` BEFORE ` + event + ` BEGIN SELECT RAISE(ABORT, 'disk full'); END`); err != nil {
		t.Fatal(err)
	}
}

func hasSession(rec *httptest.ResponseRecorder) bool {
	for _, c := range rec.Result().Cookies() {
		if c.MaxAge >= 0 && c.Value != "" {
			return true
		}
	}
	return false
}

// A sign-in whose hold cannot be recorded does not go through without it.
func TestWeakPasswordHoldFailsClosed(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "1234567890")
	refuseWrites(t, s, "no_hold", "UPDATE OF auth_upgrade ON users")
	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"1234567890"}`, nil)
	if rec.Code != http.StatusInternalServerError || hasSession(rec) {
		t.Fatalf("login with a failing hold: %d %s", rec.Code, rec.Body)
	}
}

// Same on the second-factor path: the weak mark and the hold behind it.
func TestWeakPasswordHoldFailsClosedWithSecondFactor(t *testing.T) {
	mux, s, _, sec := totpFixture(t)
	setPassword(t, s, 1, "1234567890")
	login := func() LoginResponse {
		rec := doReq(mux, "POST", "/api/auth/login", `{"email":"a@example.com","password":"1234567890"}`, nil)
		var out LoginResponse
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	refuseWrites(t, s, "no_weak", "UPDATE OF weak ON login_pending")
	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"a@example.com","password":"1234567890"}`, nil)
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "token") {
		t.Fatalf("pending without its weak mark: %d %s", rec.Code, rec.Body)
	}
	s.DB.Exec(`DROP TRIGGER no_weak`)

	out := login()
	if !out.TwoFactorRequired {
		t.Fatal("no second factor asked")
	}
	refuseWrites(t, s, "no_hold", "UPDATE OF auth_upgrade ON users")
	code, _ := totp.Code(sec, time.Now())
	rec = postTotp(mux, out.Token, code)
	if rec.Code != http.StatusInternalServerError || hasSession(rec) {
		t.Fatalf("second factor with a failing hold: %d %s", rec.Code, rec.Body)
	}
}

// A passkey from before the user-verification rule gets in only with its
// replacement hold on record.
func TestLegacyPasskeyHoldFailsClosed(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	handle := []byte("handle-of-the-test-user-32-bytes")
	s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID)
	key := newSoftKey(t, handle)
	if _, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
		VALUES (?, ?, ?, 'key', 1, 0)`, userID, key.id, key.credJSON(t)); err != nil {
		t.Fatal(err)
	}
	refuseWrites(t, s, "no_hold", "UPDATE OF auth_upgrade ON users")
	rec := doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil)
	var begin struct {
		SessionID string `json:"sessionId"`
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.Unmarshal(rec.Body.Bytes(), &begin)
	req := httptest.NewRequest("POST", "/api/auth/webauthn/login/finish",
		strings.NewReader(key.assertion(begin.PublicKey.Challenge, "example.com", "https://example.com", false)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WA-Session", begin.SessionID)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	if out.Code != http.StatusInternalServerError || hasSession(out) {
		t.Fatalf("legacy passkey with a failing hold: %d %s", out.Code, out.Body)
	}
}

// A database that cannot count users is an error, not an empty instance
// that offers the first-run wizard.
func TestAuthConfigCountFailure(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)
	s.OIDC = auth.NewManager(context.Background(), s.DB)
	if rec := doReq(mux, "GET", "/api/auth/config", "", nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"setupNeeded":false`) {
		t.Fatalf("baseline: %d %s", rec.Code, rec.Body)
	}
	s.DB.Exec(`ALTER TABLE users RENAME TO users_gone`)
	rec := doReq(mux, "GET", "/api/auth/config", "", nil)
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "setupNeeded") {
		t.Fatalf("config with a failing count: %d %s", rec.Code, rec.Body)
	}
}

// Only the UNIQUE violation is a conflict; any other failed INSERT is a 500.
func TestUserInsertErrorsAreNotConflicts(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	body := `{"email":"fresh@example.com","password":"a much better phrase"}`
	if rec := doReq(mux, "POST", "/api/users", `{"email":"user@example.com","password":"a much better phrase"}`, adminC); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate address: %d %s", rec.Code, rec.Body)
	}
	refuseWrites(t, s, "no_users", "INSERT ON users")
	if rec := doReq(mux, "POST", "/api/users", body, adminC); rec.Code != http.StatusInternalServerError {
		t.Errorf("create with a failing insert: %d %s", rec.Code, rec.Body)
	}
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('registration_disabled', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false'`)
	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"fresh2@example.com","password":"longpassword12"}`, nil); rec.Code != http.StatusInternalServerError {
		t.Errorf("register with a failing insert: %d %s", rec.Code, rec.Body)
	}
}

// The wizard does not answer ok with half a configuration.
func TestSetupOIDCWriteFailure(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)
	refuseWrites(t, s, "no_settings", "INSERT ON settings")
	rec := doReq(mux, "POST", "/api/auth/setup/oidc",
		`{"oidcIssuer":"http://127.0.0.1:1/oidc","oidcClientId":"x","oidcRedirectUrl":"http://localhost/cb"}`, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("setup with failing settings writes: %d %s", rec.Code, rec.Body)
	}
}

// An unreadable TOTP table must not read as "no second factor enrolled":
// the password alone would open a session.
func TestLoginFailsClosedWhenTotpUnreadable(t *testing.T) {
	mux, s, _, _ := totpFixture(t)
	setPassword(t, s, 1, "1234567890")
	if _, err := s.DB.Exec(`DROP TABLE user_totp`); err != nil {
		t.Fatal(err)
	}
	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"a@example.com","password":"1234567890"}`, nil)
	if rec.Code != http.StatusInternalServerError || hasSession(rec) {
		t.Fatalf("login with unreadable totp state: %d %s", rec.Code, rec.Body)
	}
}

func TestTotpEnabledSeparatesMissingFromFailure(t *testing.T) {
	_, s, _, _ := totpFixture(t)
	if on, err := s.totpEnabled(1); err != nil || !on {
		t.Fatalf("enrolled: %v, %v", on, err)
	}
	if on, err := s.totpEnabled(99); err != nil || on {
		t.Fatalf("no row: %v, %v", on, err)
	}
	s.DB.Exec(`DROP TABLE user_totp`)
	if _, err := s.totpEnabled(1); err == nil {
		t.Fatal("a failed read was reported as a clean answer")
	}
}

// A settings table that cannot be read must not read as auth_mode "password":
// manual user creation (and, with a working provider, the password endpoints)
// would be open although an admin switched them off.
func TestUserCreateFailsClosedWhenAuthModeUnreadable(t *testing.T) {
	_, s, _, _ := totpFixture(t)
	if _, err := s.DB.Exec(`DROP TABLE settings`); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/users", strings.NewReader(`{"email":"n@example.com","password":"correct horse battery 42"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handleUserCreate(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500: %s", rec.Code, rec.Body)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE email = 'n@example.com'`).Scan(&n)
	if n != 0 {
		t.Fatal("the account was created")
	}
}
