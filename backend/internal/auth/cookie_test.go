package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The Secure flag is the whole point of the helper: it has to follow the
// deployment posture in both directions. Marking it unconditionally would lock
// out plain-HTTP installs, leaving it off behind a TLS proxy leaks the session.
func TestSetCookieSecureFollowsPosture(t *testing.T) {
	defer SetProxyConfig("", false)

	for _, tc := range []struct {
		name       string
		forceHTTPS bool
		want       bool
	}{
		{"plain http", false, false},
		{"force https", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			SetProxyConfig("", tc.forceHTTPS)
			w := httptest.NewRecorder()
			SetCookie(w, httptest.NewRequest("GET", "/", nil), &http.Cookie{
				Name: "c", Value: "v", Path: "/",
			})
			got := w.Result().Cookies()[0]
			if got.Secure != tc.want {
				t.Errorf("Secure = %v, want %v", got.Secure, tc.want)
			}
			if !got.HttpOnly || got.SameSite != http.SameSiteLaxMode {
				t.Errorf("HttpOnly = %v, SameSite = %v", got.HttpOnly, got.SameSite)
			}
		})
	}
}
