package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/totp"
)

// An address with a display name or a comment is stored as the bare address:
// stored as typed, the same mailbox could hold any number of accounts.
func TestAccountEmailStoredAsBareAddress(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "registration_disabled", "false")

	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"Evil <E@X.de>","password":"a long new password"}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("register: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"e@x.de","password":"a long new password"}`, nil); rec.Code != http.StatusConflict {
		t.Errorf("the same mailbox registered twice: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/users", `{"email":"f@x.de (comment)","password":"a long new password"}`, adminC); rec.Code/100 != 2 {
		t.Fatalf("admin create: %d %s", rec.Code, rec.Body)
	}
	for _, want := range []string{"e@x.de", "f@x.de"} {
		var n int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE email = ? COLLATE BINARY`, want).Scan(&n); err != nil || n != 1 {
			t.Errorf("%s stored %d times (err %v)", want, n, err)
		}
	}
}

// An account whose stored address has capitals (made through OIDC by an
// earlier release) counts its second-factor failures and keeps its device
// cookie under the same key as its password sign-in, which lowercases what
// was typed.
func TestTotpUsesTheLoginSpellingOfTheAddress(t *testing.T) {
	mux, s, token, sec := totpFixture(t)
	if _, err := s.DB.Exec(`UPDATE users SET email = 'A@Example.com' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	before, _, _ := s.accountLimiter.left(accountKey("a@example.com"))
	if rec := postTotp(mux, token, "000000"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code: %d", rec.Code)
	}
	if after, _, _ := s.accountLimiter.left(accountKey("a@example.com")); after >= before {
		t.Errorf("a wrong code did not count against the account the password counts on: %d -> %d", before, after)
	}

	s.authLimiter.resetAll()
	code, err := totp.Code(sec, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	rec := postTotp(mux, token, code)
	if rec.Code != http.StatusOK {
		t.Fatalf("right code: %d %s", rec.Code, rec.Body)
	}
	req := httptest.NewRequest("POST", "/api/auth/login", nil)
	for _, c := range rec.Result().Cookies() {
		req.AddCookie(c)
	}
	if !s.knownDevice(req, "a@example.com") {
		t.Error("the device cookie from the second factor is not known to the password sign-in")
	}
}

// The same for a passkey and a security key: their device cookie and their
// failures go to the key the password sign-in uses.
func TestWebAuthnUsesTheLoginSpellingOfTheAddress(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	handle := []byte("handle-of-the-test-user-32-bytes")
	if _, err := s.DB.Exec(`UPDATE users SET email = 'User@Example.com', webauthn_handle = ? WHERE id = ?`, handle, userID); err != nil {
		t.Fatal(err)
	}
	passkey, key := newSoftKey(t, handle), newSoftKey(t, handle)
	if _, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
		VALUES (?, ?, ?, 'passkey', 1, 1), (?, ?, ?, 'key', 0, 0)`, userID, passkey.id, passkey.credJSON(t), userID, key.id, key.credJSON(t)); err != nil {
		t.Fatal(err)
	}
	known := func(rec *httptest.ResponseRecorder) bool {
		req := httptest.NewRequest("POST", "/api/auth/login", nil)
		for _, c := range rec.Result().Cookies() {
			req.AddCookie(c)
		}
		return s.knownDevice(req, "user@example.com")
	}

	var b waBegin
	json.Unmarshal(doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil).Body.Bytes(), &b)
	rec := waFinish(mux, "/api/auth/webauthn/login/finish",
		passkey.assertion(b.PublicKey.Challenge, "example.com", "https://example.com", true),
		map[string]string{"X-WA-Session": b.SessionID})
	if rec.Code != http.StatusOK || !known(rec) {
		t.Errorf("passkey sign-in: %d, device known %v", rec.Code, known(rec))
	}

	keyLogin := func(k *softKey) *httptest.ResponseRecorder {
		t.Helper()
		s.authLimiter.resetAll()
		token, err := s.newLoginPending(userID, false)
		if err != nil {
			t.Fatal(err)
		}
		var b waBegin
		json.Unmarshal(doReq(mux, "POST", "/api/auth/webauthn/2fa/begin", `{"token":"`+token+`"}`, nil).Body.Bytes(), &b)
		return waFinish(mux, "/api/auth/webauthn/2fa/finish",
			k.assertion(b.PublicKey.Challenge, "example.com", "https://example.com", false),
			map[string]string{"X-WA-Session": b.SessionID, "X-WA-Token": token})
	}
	before, _, _ := s.accountLimiter.left(accountKey("user@example.com"))
	if rec := keyLogin(newSoftKey(t, handle)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key: %d %s", rec.Code, rec.Body)
	}
	if after, _, _ := s.accountLimiter.left(accountKey("user@example.com")); after >= before {
		t.Errorf("a failed key did not count against the password's account key: %d -> %d", before, after)
	}
	if rec := keyLogin(key); rec.Code != http.StatusOK || !known(rec) {
		t.Errorf("security key sign-in: %d, device known %v", rec.Code, known(rec))
	}
}
