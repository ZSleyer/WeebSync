package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
)

// plexTVFake points plex.tv and its discover host at one stub answering every
// request with status and body.
func plexTVFake(t *testing.T, status *int, body *string) {
	t.Helper()
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(*status)
		io.WriteString(w, *body)
	}))
	t.Cleanup(fake.Close)
	oldTV, oldDiscover := plexTVBase, plexDiscoverBase
	plexTVBase, plexDiscoverBase = fake.URL, fake.URL
	t.Cleanup(func() { plexTVBase, plexDiscoverBase = oldTV, oldDiscover })
}

// A revoked device used to read as an empty watchlist with 200: plex.tv
// answers 401 with a JSON error body, which decoded into "no items". The UI
// then showed the account as linked and its watchlist as empty forever.
func TestPlexWatchlistReportsAnExpiredLink(t *testing.T) {
	status, body := http.StatusUnauthorized, `{"errors":[{"code":1001,"message":"User could not be authenticated"}]}`
	plexTVFake(t, &status, &body)
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email) VALUES (1, 'a@example.com')`)
	enc, err := secret.Encrypt("tok")
	if err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO plex_accounts (user_id, token_enc) VALUES (1, ?)`, enc)
	ck := cookieForUser(t, d, 1)
	get := func() int {
		req := httptest.NewRequest("GET", "/api/plex/watchlist", nil)
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}

	// not 401: the UI reads that as its own session having ended
	if code := get(); code != http.StatusForbidden {
		t.Errorf("revoked link: %d, want 403", code)
	}
	status = http.StatusForbidden
	if code := get(); code != http.StatusForbidden {
		t.Errorf("forbidden: %d, want 403", code)
	}
	status, body = http.StatusTooManyRequests, `{"errors":[{"code":429}]}`
	if code := get(); code != http.StatusBadGateway {
		t.Errorf("rate limited: %d, want 502", code)
	}
	status, body = http.StatusOK, `{"MediaContainer":{"Metadata":[{"title":"Frieren","year":2023,"type":"show"}]}}`
	if code := get(); code != http.StatusOK {
		t.Errorf("working link: %d, want 200", code)
	}
}

// Only a missing row means "not linked". A database error used to read the
// same, and the user would link again over a working account.
func TestPlexAccountStatusDoesNotHideADatabaseError(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (id, email) VALUES (1, 'a@example.com')`)
	ck := cookieForUser(t, d, 1)
	get := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/plex/account", nil)
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	if rec := get(); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"linked":false`) {
		t.Errorf("no account: %d %s, want 200 not linked", rec.Code, rec.Body.String())
	}
	if _, err := d.Exec(`DROP TABLE plex_accounts`); err != nil {
		t.Fatal(err)
	}
	if rec := get(); rec.Code != http.StatusInternalServerError {
		t.Errorf("unreadable account: %d %s, want 500", rec.Code, rec.Body.String())
	}
}

// The display name is read the same way: an error body is no name.
func TestPlexTVUserChecksTheStatus(t *testing.T) {
	status, body := http.StatusInternalServerError, `{"username":"from an error page"}`
	plexTVFake(t, &status, &body)
	s := testServer(t, &Server{DB: dbtest.Open(t)})
	if got := s.plexTVUser("tok"); got != "" {
		t.Errorf("name from a failed request: %q", got)
	}
	status, body = http.StatusOK, `{"username":"himmel"}`
	if got := s.plexTVUser("tok"); got != "himmel" {
		t.Errorf("name = %q, want himmel", got)
	}
}
