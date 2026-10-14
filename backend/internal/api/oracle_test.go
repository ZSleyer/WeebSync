package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// A session cannot guess the account's password through the factor routes:
// every wrong password spends from the account's budget like a sign-in.
func TestReauthIsNoPasswordOracle(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "longenough123")
	s.authLimiter.trusted = nil // the test client is not on a trusted network
	codes := []int{}
	for i := 0; i < 12; i++ {
		s.authLimiter.resetAll() // the per-address limit apart, only the account's
		rec := doReq(mux, "DELETE", "/api/auth/webauthn/credentials/999", `{"password":"guess-`+string(rune('a'+i))+`"}`, userC)
		codes = append(codes, rec.Code)
	}
	if codes[0] != http.StatusForbidden || codes[len(codes)-1] != http.StatusTooManyRequests {
		t.Errorf("guesses through a removal that removes nothing: %v", codes)
	}
	s.authLimiter.resetAll()
	if rec := doReq(mux, "DELETE", "/api/auth/totp", `{"password":"longenough123"}`, userC); rec.Code != http.StatusTooManyRequests {
		t.Errorf("TOTP removal while the account is held back: %d", rec.Code)
	}
}

// A security key confirms a password sign-in; it is never a sign-in alone.
func TestSecurityKeyIsNoPasskey(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	handle := []byte("handle-of-the-test-user-32-bytes")
	s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID)
	key := newSoftKey(t, handle)
	s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
		VALUES (?, ?, ?, 'key', 0, 0)`, userID, key.id, key.credJSON(t))
	rec := doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil)
	var begin struct {
		SessionID string `json:"sessionId"`
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.Unmarshal(rec.Body.Bytes(), &begin)
	req := httptest.NewRequest("POST", "/api/auth/webauthn/login/finish",
		strings.NewReader(key.assertion(begin.PublicKey.Challenge, "example.com", "https://example.com", true)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WA-Session", begin.SessionID)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	if out.Code != http.StatusUnauthorized || len(out.Result().Cookies()) != 0 {
		t.Errorf("security key signed in alone: %d %s", out.Code, out.Body)
	}
	var upgrade string
	s.DB.QueryRow(`SELECT auth_upgrade FROM users WHERE id = ?`, userID).Scan(&upgrade)
	if upgrade != "" {
		t.Errorf("a security key's attempt held the account: %q", upgrade)
	}
}

// An account waiting for approval answers the same to a right and a wrong
// password.
func TestPendingAccountIsNoPasswordOracle(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "registration_disabled", "false")
	doReq(mux, "POST", "/api/auth/register", `{"email":"neu@example.com","password":"a long new passphrase"}`, nil)
	right := doReq(mux, "POST", "/api/auth/login", `{"email":"neu@example.com","password":"a long new passphrase"}`, nil)
	wrong := doReq(mux, "POST", "/api/auth/login", `{"email":"neu@example.com","password":"not the passphrase"}`, nil)
	if right.Code != wrong.Code || right.Body.String() != wrong.Body.String() {
		t.Errorf("right %d %s, wrong %d %s", right.Code, right.Body, wrong.Code, wrong.Body)
	}
}
