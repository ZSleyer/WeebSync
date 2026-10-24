package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// Allowed values without a claim to read them from gate nobody: the callback
// refuses every sign-in instead of letting each identity in (and provisioning
// an account for it) as if the list were not there.
func TestOIDCCallbackRefusesAllowlistWithoutClaim(t *testing.T) {
	for _, c := range []struct {
		claim   string
		refused bool
	}{{"", true}, {"groups", false}} {
		m := &Manager{DB: dbtest.Open(t)}
		m.cur = &OIDC{claim: c.claim, userValues: []string{"family"}}
		req := httptest.NewRequest("GET", "/api/auth/oidc/callback?state=s&code=x", nil)
		req.AddCookie(&http.Cookie{Name: "weebsync_oidc_state", Value: "s"})
		req.AddCookie(&http.Cookie{Name: "weebsync_oidc_nonce", Value: "n"})
		rec := httptest.NewRecorder()
		m.CallbackHandler(rec, req)
		loc := rec.Header().Get("Location")
		if got := strings.Contains(loc, "oidc_error=not_allowed"); got != c.refused {
			t.Errorf("claim %q: redirected to %q, refused %v want %v", c.claim, loc, got, c.refused)
		}
	}
}
