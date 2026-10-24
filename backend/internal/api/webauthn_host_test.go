package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
)

func waSetBase(t *testing.T, s *Server, base string) {
	t.Helper()
	s.DB.Exec(`DELETE FROM settings WHERE key = 'base_url'`)
	if _, err := s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', ?)`, base); err != nil {
		t.Fatal(err)
	}
}

// waCeremonyPost sends one of the six passkey ceremony requests. The finish
// calls carry a stored ceremony and a pending login so they get as far as
// building the WebAuthn instance.
func waCeremonyPost(t *testing.T, mux *http.ServeMux, s *Server, c *http.Cookie, userID int64, path string) *httptest.ResponseRecorder {
	t.Helper()
	body := "{}"
	hdr := map[string]string{}
	if strings.HasSuffix(path, "/finish") {
		id, ok := waPut(&webauthn.SessionData{}, "")
		if !ok {
			t.Fatal("ceremony not stored")
		}
		hdr["X-WA-Session"] = id
	}
	if strings.HasPrefix(path, "/api/auth/webauthn/2fa/") {
		token, err := s.newLoginPending(userID, false)
		if err != nil {
			t.Fatal(err)
		}
		hdr["X-WA-Token"] = token
		body = `{"token":"` + token + `"}`
	}
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if strings.Contains(path, "/register/") {
		req.AddCookie(c)
	}
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}

var waCeremonyPaths = []string{
	"/api/auth/webauthn/register/begin",
	"/api/auth/webauthn/register/finish",
	"/api/auth/webauthn/login/begin",
	"/api/auth/webauthn/login/finish",
	"/api/auth/webauthn/2fa/begin",
	"/api/auth/webauthn/2fa/finish",
}

// An IP address cannot be a relying party ID: reached that way, every passkey
// ceremony answers a clear client-side refusal instead of a 500. Zoned IPv6
// addresses count too.
func TestWebAuthnCeremoniesOnIPAddressAre409(t *testing.T) {
	for _, base := range []string{
		"http://192.168.1.5:8080",
		"https://[::1]:8443",
		"https://[fe80::1%25eth0]:8443",
	} {
		for _, path := range waCeremonyPaths {
			// no slashes in a name: it becomes the test database's file name
			name := strings.NewReplacer("/", "_", ":", "_", "%", "_", "[", "_", "]", "_").Replace(base + path)
			t.Run(name, func(t *testing.T) {
				// a server of its own: the ceremonies are rate limited per client
				mux, s, _, userC, _, userID := setupUsersTest(t)
				waSetBase(t, s, base)
				out := waCeremonyPost(t, mux, s, userC, userID, path)
				if out.Code != http.StatusConflict {
					t.Fatalf("= %d %s, want 409", out.Code, out.Body)
				}
				if !strings.Contains(out.Body.String(), "host name") {
					t.Errorf("body %q does not say passkeys need a host name", out.Body)
				}
			})
		}
	}
}

func TestWebAuthnBeginOnHostNameWorks(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	waSetBase(t, s, "https://example.com")
	if out := waCeremonyPost(t, mux, s, userC, userID, "/api/auth/webauthn/login/begin"); out.Code != http.StatusOK {
		t.Fatalf("login/begin = %d %s", out.Code, out.Body)
	}
}
