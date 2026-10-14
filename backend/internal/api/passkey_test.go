package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
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
	if rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", `{"password":""}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("passkey for an OIDC account: got %d, want 403: %s", rec.Code, rec.Body)
	}

	hash, _ := auth.HashPassword("longenough123")
	s.DB.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, userID)
	json.Unmarshal(doReq(mux, "GET", "/api/auth/me", "", userC).Body.Bytes(), &me)
	if !me.HasPassword {
		t.Errorf("me: hasPassword false after setting one")
	}
	// a session alone does not add a way in: the password confirms it
	if rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", `{"password":"wrong-password"}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("passkey with a wrong password: got %d, want 403: %s", rec.Code, rec.Body)
	}
	rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", `{"password":"longenough123"}`, userC)
	if rec.Code != http.StatusOK {
		t.Fatalf("passkey for a password account: got %d, want 200: %s", rec.Code, rec.Body)
	}
	// a passkey must verify the user
	if !strings.Contains(rec.Body.String(), `"userVerification":"required"`) {
		t.Errorf("registration does not require user verification: %s", rec.Body)
	}
}

// TOTP is switched on only with the password: a stolen session could
// otherwise lock the owner out behind a code only the thief has.
func TestTotpSetupNeedsPassword(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "longenough123")
	if rec := doReq(mux, "POST", "/api/auth/totp/setup", `{"password":"wrong-password"}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("wrong password: got %d, want 403", rec.Code)
	}
	// past the check (the test has no secret key, so the setup itself may
	// fail after it)
	if rec := doReq(mux, "POST", "/api/auth/totp/setup", `{"password":"longenough123"}`, userC); rec.Code == http.StatusForbidden {
		t.Errorf("right password: got %d: %s", rec.Code, rec.Body)
	}
}

// A passkey that signed in without verifying the user holds the account until
// it is replaced or removed; removing it lets the account go on.
func TestPasskeyHoldLiftsOnRemoval(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "longenough123")
	res, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, replace_due)
		VALUES (?, x'01', '{}', 'old', 1, 1)`, userID)
	if err != nil {
		t.Fatal(err)
	}
	credID, _ := res.LastInsertId()
	s.DB.Exec(`UPDATE users SET auth_upgrade = 'passkey' WHERE id = ?`, userID)

	if rec := doReq(mux, "GET", "/api/servers", "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("held account reached the app: %d", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"longenough123","new":"another long phrase"}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("held for a passkey, the password route is not the way out: %d", rec.Code)
	}
	rec := doReq(mux, "GET", "/api/auth/webauthn/credentials", "", userC)
	if !strings.Contains(rec.Body.String(), `"replaceDue":true`) {
		t.Errorf("list does not name the passkey to replace: %s", rec.Body)
	}
	del := "/api/auth/webauthn/credentials/" + strconv.FormatInt(credID, 10)
	// the session of the unverified sign-in alone cannot lift the hold
	if rec := doReq(mux, "DELETE", del, `{"password":""}`, userC); rec.Code != http.StatusForbidden {
		t.Fatalf("remove without the password: got %d, want 403: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/servers", "", userC); rec.Code != http.StatusForbidden {
		t.Fatalf("hold lifted by a refused removal: %d", rec.Code)
	}
	if rec := doReq(mux, "DELETE", del, `{"password":"longenough123"}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("remove: got %d: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/servers", "", userC); rec.Code != http.StatusOK {
		t.Errorf("hold not lifted after removal: %d %s", rec.Code, rec.Body)
	}
}

// The login page asks for a passkey challenge on every visit. Those requests
// used to share the password login's five attempts, so five page loads locked
// out the right password.
func TestPasskeyChallengeLeavesLoginBudget(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	s.DB.Exec(`UPDATE users SET email_verified = 1 WHERE id = ?`, userID)

	for range 8 {
		if rec := doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil); rec.Code != http.StatusOK {
			t.Fatalf("challenge: got %d: %s", rec.Code, rec.Body)
		}
	}
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"longenough123"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("login after page loads: got %d, want 200: %s", rec.Code, rec.Body)
	}
}
