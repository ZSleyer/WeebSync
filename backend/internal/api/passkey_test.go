package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
)

// An account without a password exists through OIDC, whose provider decides
// on every login whether it may still get in. A passkey would be a way in that
// never asks the provider again, so such an account cannot add one; a security
// key as the second factor of a password login stays open to everyone else.
func TestPasskeyNeedsPassword(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)

	var me MeResponse
	json.Unmarshal(doReq(mux, "GET", "/api/auth/me", "", userC).Body.Bytes(), &me)
	if me.HasPassword {
		t.Fatalf("me: hasPassword true for an account without one")
	}
	if rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("passkey for an OIDC account: got %d, want 403: %s", rec.Code, rec.Body)
	}

	hash, _ := auth.HashPassword("longenough123")
	s.DB.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, userID)
	json.Unmarshal(doReq(mux, "GET", "/api/auth/me", "", userC).Body.Bytes(), &me)
	if !me.HasPassword {
		t.Errorf("me: hasPassword false after setting one")
	}
	if rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", "", userC); rec.Code != http.StatusOK {
		t.Errorf("passkey for a password account: got %d, want 200: %s", rec.Code, rec.Body)
	}
}
