package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// testSetupToken is the first-run token every test server gets; doReq sends
// it, so tests that start from an empty database can register as before.
const testSetupToken = "test-setup-token-for-tests"

func TestMain(m *testing.M) {
	os.Setenv("WEEBSYNC_SETUP_TOKEN", testSetupToken)
	os.Exit(m.Run())
}

// A fresh instance takes its first account and its provider config only with
// the token from the log: without it, or with a wrong one, the first visitor
// from the internet owns nothing.
func TestFirstRunNeedsSetupToken(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)})
	mux := http.NewServeMux()
	s.Register(mux)
	post := func(path, body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set(setupTokenHeader, token)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	reg := `{"email":"first@example.com","password":"the very first admin"}`
	for _, tok := range []string{"", "wrong-token-xxxx"} {
		if rec := post("/api/auth/register", reg, tok); rec.Code != http.StatusForbidden {
			t.Errorf("first account with token %q: %d %s", tok, rec.Code, rec.Body)
		}
		if rec := post("/api/auth/setup/oidc", `{"oidcIssuer":"http://127.0.0.1:1/x","oidcClientId":"x","oidcRedirectUrl":"http://localhost/cb"}`, tok); rec.Code != http.StatusForbidden {
			t.Errorf("setup oidc with token %q: %d %s", tok, rec.Code, rec.Body)
		}
		if rec := post("/api/auth/oidc/discover", `{"url":"https://idp.example.com"}`, tok); rec.Code != http.StatusForbidden {
			t.Errorf("discover with token %q: %d %s", tok, rec.Code, rec.Body)
		}
	}
	s.authLimiter.resetAll() // the per-address limit counts the refusals above
	// typed as people copy it: other case, dashes, spaces
	if rec := post("/api/auth/register", reg, " TEST-SETUP-TOKEN-FOR-TESTS "); rec.Code != http.StatusCreated {
		t.Fatalf("first account with the token: %d %s", rec.Code, rec.Body)
	}
	s.authLimiter.resetAll()
	// after the first account the token opens nothing any more
	if rec := post("/api/auth/setup/oidc", `{"oidcIssuer":"x"}`, testSetupToken); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "already completed") {
		t.Errorf("setup after the first account: %d %s", rec.Code, rec.Body)
	}
}

func TestSetupTokenShape(t *testing.T) {
	tok := newSetupToken()
	if len(tok) != 24 || strings.Count(tok, "-") != 4 {
		t.Errorf("token %q", tok)
	}
	if newSetupToken() == tok {
		t.Error("two tokens alike")
	}
}
