package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A browser request from another site, a sibling subdomain included, is
// refused on state-changing routes; our own pages, the configured public
// origin behind a Host-rewriting proxy, and non-browser callers get through.
func TestCrossOriginGuard(t *testing.T) {
	d := dbtest.Open(t)
	db.SetSetting(d, "base_url", "https://weebsync.example.com")
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)
	h := s.CrossOrigin(mux)

	do := func(method, path string, hdr map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(""))
		req.Host = "weebsync:8080" // what the proxy hands on
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	refused := func(rec *httptest.ResponseRecorder) bool {
		return rec.Code == http.StatusForbidden && strings.Contains(rec.Body.String(), "cross-origin")
	}

	for name, hdr := range map[string]map[string]string{
		"cross-site":                  {"Sec-Fetch-Site": "cross-site"},
		"sibling subdomain":           {"Sec-Fetch-Site": "same-site", "Origin": "https://other.example.com"},
		"old browser, foreign origin": {"Origin": "https://evil.example"},
	} {
		if rec := do("POST", "/api/auth/logout", hdr); !refused(rec) {
			t.Errorf("%s: got %d %s, want refused", name, rec.Code, rec.Body)
		}
	}
	for name, hdr := range map[string]map[string]string{
		"own page":                      {"Sec-Fetch-Site": "same-origin"},
		"old browser, public origin":    {"Origin": "https://weebsync.example.com"},
		"not a browser (IdP, arr apps)": {},
	} {
		if rec := do("POST", "/api/auth/logout", hdr); refused(rec) {
			t.Errorf("%s: refused", name)
		}
	}
	// reads stay open to links from anywhere
	if rec := do("GET", "/api/auth/config", map[string]string{"Sec-Fetch-Site": "cross-site"}); refused(rec) {
		t.Error("cross-site GET refused")
	}
	// the provider's back-channel logout carries neither header
	if rec := do("POST", "/api/auth/oidc/backchannel-logout", nil); refused(rec) {
		t.Error("back-channel logout refused")
	}
}
