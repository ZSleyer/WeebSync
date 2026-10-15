package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/totp"
)

// A weak password with a second factor holds the account only once the code
// is right: whoever knows the old password but not the code must not put the
// owner's sessions on hold.
func TestWeakPasswordHoldWaitsForSecondFactor(t *testing.T) {
	mux, s, _, sec := totpFixture(t)
	setPassword(t, s, 1, "1234567890")
	upgrade := func() string {
		var v string
		s.DB.QueryRow(`SELECT auth_upgrade FROM users WHERE id = 1`).Scan(&v)
		return v
	}
	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"a@example.com","password":"1234567890"}`, nil)
	var out LoginResponse
	json.Unmarshal(rec.Body.Bytes(), &out)
	if !out.TwoFactorRequired {
		t.Fatalf("no second factor asked: %s", rec.Body)
	}
	if got := upgrade(); got != "" {
		t.Fatalf("held before the second factor: %q", got)
	}
	postTotp(mux, out.Token, "000000")
	if got := upgrade(); got != "" {
		t.Fatalf("held after a wrong code: %q", got)
	}
	code, _ := totp.Code(sec, time.Now())
	if rec := postTotp(mux, out.Token, code); rec.Code != http.StatusOK {
		t.Fatalf("right code: %d %s", rec.Code, rec.Body)
	}
	if got := upgrade(); got != "password" {
		t.Errorf("not held after the full sign-in: %q", got)
	}
}

// A password hold set over a passkey hold does not swallow it: once the new
// password is in, the passkey still waiting to be replaced holds again.
func TestPasswordChangeKeepsPasskeyHold(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "1234567890")
	s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, replace_due)
		VALUES (?, x'02', '{}', 'old', 1, 1)`, userID)
	s.DB.Exec(`UPDATE users SET auth_upgrade = 'password' WHERE id = ?`, userID)
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"1234567890","new":"a much better phrase"}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("change: %d %s", rec.Code, rec.Body)
	}
	var v string
	s.DB.QueryRow(`SELECT auth_upgrade FROM users WHERE id = ?`, userID).Scan(&v)
	if v != "passkey" {
		t.Errorf("hold after the password change: %q, want passkey", v)
	}
}
