package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A provider that announces S256 gets a code challenge on every login and the
// verifier stays in a cookie; one that does not gets neither, so a provider
// that would choke on the parameter keeps working.
func TestOIDCPKCEFollowsDiscovery(t *testing.T) {
	for _, announce := range []bool{true, false} {
		var issuer string
		idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			doc := map[string]any{
				"issuer":                 issuer,
				"authorization_endpoint": issuer + "/auth",
				"token_endpoint":         issuer + "/token",
				"jwks_uri":               issuer + "/jwks",
			}
			if announce {
				doc["code_challenge_methods_supported"] = []string{"plain", "S256"}
			}
			json.NewEncoder(w).Encode(doc)
		}))
		issuer = idp.URL
		d := dbtest.Open(t)
		db.SetSetting(d, "oidc_issuer", issuer)
		db.SetSetting(d, "oidc_client_id", "weebsync")
		db.SetSetting(d, "oidc_redirect_url", "https://weebsync.example.com/api/auth/oidc/callback")
		m := NewManager(context.Background(), d)
		if !m.Enabled() {
			idp.Close()
			t.Fatal("provider did not load")
		}
		rec := httptest.NewRecorder()
		m.LoginHandler(rec, httptest.NewRequest("GET", "/api/auth/oidc/login", nil))
		loc, _ := url.Parse(rec.Header().Get("Location"))
		q := loc.Query()
		var pkceCookie bool
		for _, c := range rec.Result().Cookies() {
			if c.Name == "weebsync_oidc_pkce" && c.Value != "" {
				pkceCookie = true
			}
		}
		if announce && (q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" || !pkceCookie) {
			t.Errorf("S256 announced: challenge=%q method=%q cookie=%v", q.Get("code_challenge"), q.Get("code_challenge_method"), pkceCookie)
		}
		if !announce && (q.Has("code_challenge") || pkceCookie) {
			t.Errorf("S256 not announced, still sent a challenge: %s", loc)
		}
		idp.Close()
	}
}
