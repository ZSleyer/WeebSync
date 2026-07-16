package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/transfer"
)

func doBearer(mux *http.ServeMux, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestApiToken(t *testing.T) {
	mux, s, adminC, userC, _, _ := setupUsersTest(t)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	s.DownloadRoot = t.TempDir()

	// no token configured → bearer rejected
	if rec := doBearer(mux, "GET", "/api/status", "deadbeef"); rec.Code != http.StatusUnauthorized {
		t.Errorf("bearer without configured token: got %d, want 401", rec.Code)
	}
	// no cookie, no bearer → 401
	if rec := doBearer(mux, "GET", "/api/status", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous status: got %d, want 401", rec.Code)
	}

	// non-admin cannot mint a token
	if rec := doReq(mux, "POST", "/api/settings/token", "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin token create: got %d, want 403", rec.Code)
	}
	// admin mints a token
	rec := doReq(mux, "POST", "/api/settings/token", "", adminC)
	if rec.Code != http.StatusOK {
		t.Fatalf("token create: got %d: %s", rec.Code, rec.Body)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Token) != 64 {
		t.Fatalf("token payload: %s", rec.Body)
	}

	// valid bearer → status works
	if rec := doBearer(mux, "GET", "/api/status", out.Token); rec.Code != http.StatusOK {
		t.Errorf("bearer status: got %d: %s", rec.Code, rec.Body)
	}
	// admin session also works (debugging path)
	if rec := doReq(mux, "GET", "/api/status", "", adminC); rec.Code != http.StatusOK {
		t.Errorf("admin session status: got %d", rec.Code)
	}
	// non-admin session denied
	if rec := doReq(mux, "GET", "/api/status", "", userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin session status: got %d, want 403", rec.Code)
	}
	// wrong token → 401
	if rec := doBearer(mux, "GET", "/api/status", "0000"); rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong bearer: got %d, want 401", rec.Code)
	}
	// bearer is scoped: unrelated route rejects it (no session either)
	if rec := doBearer(mux, "GET", "/api/settings", out.Token); rec.Code != http.StatusUnauthorized {
		t.Errorf("bearer on settings: got %d, want 401", rec.Code)
	}

	// machine watch-check: missing watch → 404
	if rec := doBearer(mux, "POST", "/api/watches/999/check", out.Token); rec.Code != http.StatusNotFound {
		t.Errorf("machine check missing watch: got %d, want 404", rec.Code)
	}

	// revoke → bearer dead
	if rec := doReq(mux, "DELETE", "/api/settings/token", "", adminC); rec.Code != http.StatusOK {
		t.Fatalf("token delete: got %d", rec.Code)
	}
	if rec := doBearer(mux, "GET", "/api/status", out.Token); rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked bearer: got %d, want 401", rec.Code)
	}
}
