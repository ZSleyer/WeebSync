package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func waLoginBegin(mux *http.ServeMux) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/auth/webauthn/login/begin", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}

// An IP address cannot be a relying party ID: reached that way, the passkey
// ceremonies answer a clear client-side refusal instead of a 500.
func TestWebAuthnBeginOnIPAddressIsNot500(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)
	for _, base := range []string{"http://192.168.1.5:8080", "https://[::1]:8443"} {
		s.DB.Exec(`DELETE FROM settings WHERE key = 'base_url'`)
		s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', ?)`, base)
		out := waLoginBegin(mux)
		if out.Code != http.StatusConflict {
			t.Fatalf("%s: login/begin = %d %s, want 409", base, out.Code, out.Body)
		}
		if !strings.Contains(out.Body.String(), "host name") {
			t.Errorf("%s: body %q does not say passkeys need a host name", base, out.Body)
		}
	}
}

func TestWebAuthnBeginOnHostNameWorks(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	if out := waLoginBegin(mux); out.Code != http.StatusOK {
		t.Fatalf("login/begin = %d %s", out.Code, out.Body)
	}
}
