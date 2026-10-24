package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type waBegin struct {
	SessionID string `json:"sessionId"`
	PublicKey struct {
		Challenge string `json:"challenge"`
	} `json:"publicKey"`
}

func waFinish(mux *http.ServeMux, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}

// A key whose signature counter does not move past the stored one may be a
// copy of the real one: the sign-in is refused, as passkey and as second
// factor, and the stored counter stays where it was.
func TestWebAuthnCloneWarningRefusesSignIn(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	handle := []byte("handle-of-the-test-user-32-bytes")
	s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID)
	passkey := newSoftKey(t, handle)
	key := newSoftKey(t, handle)
	if _, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
		VALUES (?, ?, ?, 'passkey', 1, 1), (?, ?, ?, 'key', 0, 0)`, userID, passkey.id, passkey.credJSON(t), userID, key.id, key.credJSON(t)); err != nil {
		t.Fatal(err)
	}
	signCount := func(k *softKey) uint32 {
		t.Helper()
		var raw []byte
		if err := s.DB.QueryRow(`SELECT cred_json FROM webauthn_credentials WHERE credential_id = ?`, k.id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var c struct{ Authenticator struct{ SignCount uint32 } }
		json.Unmarshal(raw, &c)
		return c.Authenticator.SignCount
	}

	passkeyLogin := func() *httptest.ResponseRecorder {
		t.Helper()
		s.authLimiter.resetAll()
		var b waBegin
		json.Unmarshal(doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil).Body.Bytes(), &b)
		return waFinish(mux, "/api/auth/webauthn/login/finish",
			passkey.assertion(b.PublicKey.Challenge, "example.com", "https://example.com", true),
			map[string]string{"X-WA-Session": b.SessionID})
	}
	if rec := passkeyLogin(); rec.Code != http.StatusOK {
		t.Fatalf("first passkey sign-in: %d %s", rec.Code, rec.Body)
	}
	passkey.count = 0 // the copy has its own, lower counter
	if rec := passkeyLogin(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("passkey with a counter that went back: %d %s", rec.Code, rec.Body)
	}
	if n := signCount(passkey); n != 1 {
		t.Errorf("stored counter after the refused sign-in: %d, want 1", n)
	}

	keyLogin := func() *httptest.ResponseRecorder {
		t.Helper()
		s.authLimiter.resetAll()
		token, err := s.newLoginPending(userID, false)
		if err != nil {
			t.Fatal(err)
		}
		var b waBegin
		json.Unmarshal(doReq(mux, "POST", "/api/auth/webauthn/2fa/begin", `{"token":"`+token+`"}`, nil).Body.Bytes(), &b)
		return waFinish(mux, "/api/auth/webauthn/2fa/finish",
			key.assertion(b.PublicKey.Challenge, "example.com", "https://example.com", false),
			map[string]string{"X-WA-Session": b.SessionID, "X-WA-Token": token})
	}
	if rec := keyLogin(); rec.Code != http.StatusOK {
		t.Fatalf("first security-key sign-in: %d %s", rec.Code, rec.Body)
	}
	key.count = 0
	if rec := keyLogin(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("security key with a counter that went back: %d %s", rec.Code, rec.Body)
	}
	if n := signCount(key); n != 1 {
		t.Errorf("stored key counter after the refused sign-in: %d, want 1", n)
	}
	// the real key, counting on, still gets in
	key.count = 5
	if rec := keyLogin(); rec.Code != http.StatusOK {
		t.Fatalf("real key after a refused copy: %d %s", rec.Code, rec.Body)
	}
}
