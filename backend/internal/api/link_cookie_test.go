package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// linkCookieServer is a server with one user and a session for it, made over
// the given scheme so the session cookie carries the name that scheme uses.
func linkCookieServer(t *testing.T, scheme string) (*http.ServeMux, *http.Cookie) {
	t.Helper()
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	mux := http.NewServeMux()
	s.Register(mux)
	if _, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	db.SetSetting(d, "anilist_client_id", "123")
	db.SetSetting(d, "anilist_client_secret", "sec")
	rec := httptest.NewRecorder()
	if err := auth.CreateSession(d, rec, httptest.NewRequest("GET", scheme+"://weebsync.test/", nil), 1, true); err != nil {
		t.Fatal(err)
	}
	return mux, rec.Result().Cookies()[0]
}

func linkGet(mux *http.ServeMux, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", target, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func setCookieNamed(rec *httptest.ResponseRecorder, suffix string) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if strings.HasSuffix(c.Name, suffix) {
			return c
		}
	}
	return nil
}

// Under HTTPS the link-flow cookies carry the __Host- prefix like the session
// and OIDC cookies, so a sister subdomain cannot plant a state of its own;
// over plain HTTP they keep the plain name, which is all a browser accepts
// there.
func TestAnilistStateCookieHostPrefixed(t *testing.T) {
	for _, tc := range []struct{ scheme, name, path string }{
		{"https", "__Host-weebsync_anilist_state", "/"},
		{"http", "weebsync_anilist_state", "/api/anilist"},
	} {
		mux, session := linkCookieServer(t, tc.scheme)
		base := tc.scheme + "://weebsync.test"
		rec := linkGet(mux, base+"/api/anilist/connect", session)
		if rec.Code != http.StatusFound {
			t.Fatalf("%s connect: %d %s", tc.scheme, rec.Code, rec.Body)
		}
		c := setCookieNamed(rec, "weebsync_anilist_state")
		if c == nil || c.Name != tc.name || c.Path != tc.path || c.Secure != (tc.scheme == "https") {
			t.Fatalf("%s state cookie = %+v, want %s at %s", tc.scheme, c, tc.name, tc.path)
		}
		// the cookie it set is the one the callback reads: past the state
		// check, the missing code is what fails
		rec = linkGet(mux, base+"/api/anilist/callback?state="+c.Value, session, &http.Cookie{Name: c.Name, Value: c.Value})
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "missing code") {
			t.Errorf("%s callback with its own cookie: %d %s", tc.scheme, rec.Code, rec.Body)
		}
	}
	// under HTTPS a plain-named state (one a sister subdomain could set) counts for nothing
	mux, session := linkCookieServer(t, "https")
	rememberLinkFlow("anilist", "planted", 1)
	rec := linkGet(mux, "https://weebsync.test/api/anilist/callback?state=planted&code=x", session,
		&http.Cookie{Name: "weebsync_anilist_state", Value: "planted"})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid state") {
		t.Errorf("plain-named state over HTTPS: %d %s", rec.Code, rec.Body)
	}
}

// An empty state proves nothing, even when the cookie and the query agree on
// it and a flow happens to be remembered under "".
func TestLinkCallbacksRefuseEmptyState(t *testing.T) {
	mux, session := linkCookieServer(t, "http")
	rememberLinkFlow("anilist", "", 1)
	rememberLinkFlow("tmdb", "", 1)
	defer forgetLinkFlow("anilist", "")
	defer forgetLinkFlow("tmdb", "")
	rec := linkGet(mux, "http://weebsync.test/api/anilist/callback?state=&code=x", session,
		&http.Cookie{Name: "weebsync_anilist_state", Value: ""})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid state") {
		t.Errorf("anilist empty state: %d %s", rec.Code, rec.Body)
	}
	rec = linkGet(mux, "http://weebsync.test/api/tmdb/callback?request_token=&denied=true", session,
		&http.Cookie{Name: "weebsync_tmdb_rt", Value: ""})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("tmdb empty request token: %d %s", rec.Code, rec.Body)
	}
}

// The TMDB request-token cookie follows the same naming: the callback reads
// the host-prefixed one under HTTPS and ignores a plain-named one.
func TestTmdbRequestTokenCookieHostPrefixed(t *testing.T) {
	mux, session := linkCookieServer(t, "https")
	rememberLinkFlow("tmdb", "rt-1", 1)
	rec := linkGet(mux, "https://weebsync.test/api/tmdb/callback?request_token=rt-1&denied=true", session,
		&http.Cookie{Name: "weebsync_tmdb_rt", Value: "rt-1"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("plain-named request token over HTTPS: %d %s", rec.Code, rec.Body)
	}
	rec = linkGet(mux, "https://weebsync.test/api/tmdb/callback?request_token=rt-1&denied=true", session,
		&http.Cookie{Name: "__Host-weebsync_tmdb_rt", Value: "rt-1"})
	if rec.Code != http.StatusFound {
		t.Fatalf("host-prefixed request token: %d %s", rec.Code, rec.Body)
	}
	if c := setCookieNamed(rec, "weebsync_tmdb_rt"); c == nil || c.Name != "__Host-weebsync_tmdb_rt" || c.Path != "/" || c.MaxAge >= 0 {
		t.Errorf("request token cookie not cleared under its own name: %+v", c)
	}
}
