package auth

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// overTLS is a request that arrived over HTTPS.
func overTLS(method, target string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.TLS = &tls.ConnectionState{}
	return r
}

func cookieNamed(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// Under HTTPS the session cookie carries the __Host- prefix (Secure, Path=/,
// no Domain), which a sister subdomain cannot set; plain HTTP keeps the old
// name, since a browser refuses a prefixed cookie without Secure.
func TestSessionCookieIsHostPrefixedUnderHTTPS(t *testing.T) {
	restore(t)
	SetProxyConfig("", false)
	d := dbtest.Open(t)
	id, err := findOrCreateOIDCUser(d, "a@example.com", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	if err := CreateSession(d, w, overTLS("POST", "/api/auth/login"), id, true); err != nil {
		t.Fatal(err)
	}
	c := cookieNamed(w, "__Host-weebsync_session")
	if c == nil || !c.Secure || c.Path != "/" || c.Domain != "" {
		t.Fatalf("session cookie over HTTPS: %+v", w.Result().Cookies())
	}
	w = httptest.NewRecorder()
	if err := CreateSession(d, w, httptest.NewRequest("POST", "/api/auth/login", nil), id, true); err != nil {
		t.Fatal(err)
	}
	if c := cookieNamed(w, "weebsync_session"); c == nil || c.Secure {
		t.Fatalf("session cookie over plain HTTP: %+v", w.Result().Cookies())
	}
}

// The scenario: a sister subdomain sets weebsync_session (Domain=.example.com)
// to the attacker's own session, and the victim's requests ran in the
// attacker's account. The legacy name is now believed only for a session
// from before the prefix, moved over on first use; never over a prefixed
// cookie, and never for a session made since.
func TestLegacySessionCookieOnlyMigrates(t *testing.T) {
	restore(t)
	SetProxyConfig("", false)
	d := dbtest.Open(t)
	victim, _ := findOrCreateOIDCUser(d, "victim@example.com", nil, true)
	attacker, _ := findOrCreateOIDCUser(d, "attacker@example.com", nil, true)
	// both are let in: a refusal below must come from the cookie, not from
	// an account still waiting for approval
	if _, err := d.Exec(`UPDATE users SET approved = 1`); err != nil {
		t.Fatal(err)
	}
	// a session from before the prefix, made by an older version
	oldToken := "0123456789abcdef"
	old := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen, remember) VALUES (?, ?, '2999-01-01T00:00:00Z', ?, ?, 1)`,
		hashToken(oldToken), victim, old, old); err != nil {
		t.Fatal(err)
	}
	// after the upgrade the attacker mints a session over plain HTTP (no
	// mark, legacy name) to toss it into an HTTPS browser
	pw := httptest.NewRecorder()
	if err := CreateSession(d, pw, httptest.NewRequest("POST", "/api/auth/login", nil), attacker, true); err != nil {
		t.Fatal(err)
	}
	plainToken := cookieNamed(pw, "weebsync_session").Value
	// and signs in over HTTPS too
	aw := httptest.NewRecorder()
	if err := CreateSession(d, aw, overTLS("POST", "/api/auth/login"), attacker, true); err != nil {
		t.Fatal(err)
	}
	attackerToken := cookieNamed(aw, "__Host-weebsync_session").Value
	vw := httptest.NewRecorder()
	if err := CreateSession(d, vw, overTLS("POST", "/api/auth/login"), victim, true); err != nil {
		t.Fatal(err)
	}
	victimToken := cookieNamed(vw, "__Host-weebsync_session").Value

	me := func(cookies ...*http.Cookie) (string, *httptest.ResponseRecorder) {
		r := overTLS("GET", "/api/auth/me")
		for _, c := range cookies {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		who := ""
		Middleware(d, true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			who = UserFrom(r.Context()).Email
		})).ServeHTTP(w, r)
		return who, w
	}
	// tossed under the legacy name onto a browser without a session
	if who, w := me(&http.Cookie{Name: "weebsync_session", Value: attackerToken}); who != "" || w.Code != http.StatusUnauthorized {
		t.Errorf("tossed legacy cookie signed in as %q (%d)", who, w.Code)
	}
	// a plain-HTTP session made since the cutoff is no migration either
	if who, w := me(&http.Cookie{Name: "weebsync_session", Value: plainToken}); who != "" || w.Code != http.StatusUnauthorized {
		t.Errorf("post-cutoff plain-HTTP session under the legacy name signed in as %q (%d)", who, w.Code)
	}
	// and a token made under the prefix counts under the legacy name on no
	// scheme, plain HTTP included
	pr := httptest.NewRequest("GET", "/api/auth/me", nil)
	pr.AddCookie(&http.Cookie{Name: "weebsync_session", Value: attackerToken})
	pwho := ""
	Middleware(d, false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := UserFrom(r.Context()); u != nil {
			pwho = u.Email
		}
	})).ServeHTTP(httptest.NewRecorder(), pr)
	if pwho != "" {
		t.Errorf("prefixed token under the legacy name over plain HTTP signed in as %q", pwho)
	}
	// tossed next to the victim's own: the prefixed one wins
	if who, _ := me(&http.Cookie{Name: "weebsync_session", Value: attackerToken}, &http.Cookie{Name: "__Host-weebsync_session", Value: victimToken}); who != "victim@example.com" {
		t.Errorf("with both cookies the request ran as %q", who)
	}
	// a session from before the prefix is taken once and moved over
	who, w := me(&http.Cookie{Name: "weebsync_session", Value: oldToken})
	if who != "victim@example.com" {
		t.Fatalf("pre-prefix session refused: %q (%d)", who, w.Code)
	}
	if c := cookieNamed(w, "__Host-weebsync_session"); c == nil || c.Value != oldToken || !c.Secure || c.Path != "/" {
		t.Errorf("migrated cookie: %+v", w.Result().Cookies())
	}
	if c := cookieNamed(w, "weebsync_session"); c == nil || c.MaxAge >= 0 {
		t.Errorf("legacy cookie not dropped: %+v", w.Result().Cookies())
	}
	// logout clears both names
	lw := httptest.NewRecorder()
	lr := overTLS("POST", "/api/auth/logout")
	lr.AddCookie(&http.Cookie{Name: "__Host-weebsync_session", Value: victimToken})
	if err := DestroySession(d, lw, lr); err != nil {
		t.Fatal(err)
	}
	if cookieNamed(lw, "__Host-weebsync_session") == nil || cookieNamed(lw, "weebsync_session") == nil {
		t.Errorf("logout cookies: %+v", lw.Result().Cookies())
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, hashToken(victimToken)).Scan(&n); err != nil || n != 0 {
		t.Errorf("logged-out session still there: %d %v", n, err)
	}
}

// The OIDC round trip's cookies are host-prefixed under HTTPS too, and an
// empty state never matches: a tossed empty state cookie plus "state=" used
// to pass the check (login CSRF with the attacker's code).
func TestOIDCStateCookies(t *testing.T) {
	restore(t)
	SetProxyConfig("", false)
	m := &Manager{DB: dbtest.Open(t)}
	m.cur = &OIDC{pkce: true}
	w := httptest.NewRecorder()
	m.LoginHandler(w, overTLS("GET", "/api/auth/oidc/login"))
	for _, name := range []string{"state", "nonce", "remember", "pkce"} {
		c := cookieNamed(w, "__Host-weebsync_oidc_"+name)
		if c == nil || !c.Secure || c.Path != "/" || c.Domain != "" {
			t.Errorf("%s cookie over HTTPS: %+v", name, c)
		}
	}
	for _, tc := range []struct {
		name string
		r    *http.Request
		c    string
	}{
		{"plain http", httptest.NewRequest("GET", "/api/auth/oidc/callback?state=&code=x", nil), "weebsync_oidc_state"},
		{"https", overTLS("GET", "/api/auth/oidc/callback?state=&code=x"), "__Host-weebsync_oidc_state"},
	} {
		tc.r.AddCookie(&http.Cookie{Name: tc.c, Value: ""})
		w := httptest.NewRecorder()
		m.CallbackHandler(w, tc.r)
		if loc := w.Header().Get("Location"); !strings.Contains(loc, "oidc_error=invalid_state") {
			t.Errorf("%s: empty state led to %q", tc.name, loc)
		}
	}
	// over HTTPS the unprefixed name a sister subdomain can set counts for nothing
	r := overTLS("GET", "/api/auth/oidc/callback?state=s&code=x")
	r.AddCookie(&http.Cookie{Name: "weebsync_oidc_state", Value: "s"})
	w = httptest.NewRecorder()
	m.CallbackHandler(w, r)
	if loc := w.Header().Get("Location"); !strings.Contains(loc, "oidc_error=invalid_state") {
		t.Errorf("unprefixed state over HTTPS led to %q", loc)
	}
}

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
