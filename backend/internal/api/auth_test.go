package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

func TestSetupNeeded(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)

	setupNeeded := func() bool {
		rec := doReq(mux, "GET", "/api/auth/config", "", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("config: got %d", rec.Code)
		}
		var cfg struct {
			SetupNeeded bool `json:"setupNeeded"`
		}
		json.Unmarshal(rec.Body.Bytes(), &cfg)
		return cfg.SetupNeeded
	}

	if !setupNeeded() {
		t.Error("empty db: setupNeeded should be true")
	}
	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"a@example.com","password":"longenough123"}`, nil); rec.Code != http.StatusCreated {
		t.Fatalf("register: got %d: %s", rec.Code, rec.Body)
	}
	if setupNeeded() {
		t.Error("after first user: setupNeeded should be false")
	}
}

func TestSetupOIDC(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)

	if rec := doReq(mux, "POST", "/api/auth/setup/oidc", `{}`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("empty issuer: got %d, want 400", rec.Code)
	}
	// unreachable issuer: config is stored, reload fails → oidcError, still 200
	rec := doReq(mux, "POST", "/api/auth/setup/oidc",
		`{"oidcIssuer":"http://127.0.0.1:1/oidc","oidcClientId":"x","oidcRedirectUrl":"http://localhost/cb"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup oidc: got %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		OidcEnabled bool   `json:"oidcEnabled"`
		OidcError   string `json:"oidcError"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out.OidcEnabled || out.OidcError == "" {
		t.Errorf("unreachable issuer: enabled=%v err=%q", out.OidcEnabled, out.OidcError)
	}

	// once a user exists the endpoint is gone
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	if rec := doReq(mux, "POST", "/api/auth/setup/oidc", `{"oidcIssuer":"http://127.0.0.1:1/oidc"}`, nil); rec.Code != http.StatusForbidden {
		t.Errorf("with users: got %d, want 403", rec.Code)
	}
}

func TestOIDCDiscover(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)

	// provider mounted under /oidc, root has no discovery document
	prov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oidc/.well-known/openid-configuration" {
			json.NewEncoder(w).Encode(map[string]string{"issuer": "http://" + r.Host + "/oidc"})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(prov.Close)

	if rec := doReq(mux, "POST", "/api/auth/oidc/discover", `{"url":""}`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("empty url: got %d, want 400", rec.Code)
	}
	// zero users: open, finds the provider via the /oidc fallback path
	rec := doReq(mux, "POST", "/api/auth/oidc/discover", `{"url":"`+prov.URL+`"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("discover: got %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Issuer string `json:"issuer"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if want := prov.URL + "/oidc"; out.Issuer != want {
		t.Errorf("issuer: got %q, want %q", out.Issuer, want)
	}
	if rec := doReq(mux, "POST", "/api/auth/oidc/discover", `{"url":"http://127.0.0.1:1"}`, nil); rec.Code != http.StatusNotFound {
		t.Errorf("no provider: got %d, want 404", rec.Code)
	}

	// with users: anonymous 403, admin session ok
	res, _ := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	adminID, _ := res.LastInsertId()
	if rec := doReq(mux, "POST", "/api/auth/oidc/discover", `{"url":"`+prov.URL+`"}`, nil); rec.Code != http.StatusForbidden {
		t.Errorf("anon with users: got %d, want 403", rec.Code)
	}
	sess := httptest.NewRecorder()
	if err := auth.CreateSession(d, sess, httptest.NewRequest("GET", "/", nil), adminID); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "POST", "/api/auth/oidc/discover", `{"url":"`+prov.URL+`"}`, sess.Result().Cookies()[0]); rec.Code != http.StatusOK {
		t.Errorf("admin with users: got %d, want 200: %s", rec.Code, rec.Body)
	}
}
