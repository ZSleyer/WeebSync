package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// A session without "stay signed in" lives as long as the browser session and
// ends after twelve idle hours; a remembered one survives that and slides with
// use. Sessions from before last_seen existed keep working and get stamped.
func TestSessionIdle(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	start := func(remember bool) *http.Cookie {
		rec := httptest.NewRecorder()
		if err := auth.CreateSession(s.DB, rec, httptest.NewRequest("GET", "/", nil), userID, remember); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0]
	}
	setSeen := func(c *http.Cookie, ago time.Duration) {
		stamp := ""
		if ago > 0 {
			stamp = time.Now().Add(-ago).UTC().Format(time.RFC3339)
		}
		s.DB.Exec(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`, stamp, auth.TokenHash(c.Value))
	}
	me := func(c *http.Cookie) int { return doReq(mux, "GET", "/api/auth/me", "", c).Code }

	short := start(false)
	if !short.Expires.IsZero() || short.MaxAge != 0 {
		t.Errorf("short session cookie outlives the browser: expires=%v maxAge=%d", short.Expires, short.MaxAge)
	}
	long := start(true)
	if time.Until(long.Expires) < 89*24*time.Hour {
		t.Errorf("remembered cookie expires %v", long.Expires)
	}

	setSeen(short, 13*time.Hour)
	setSeen(long, 13*time.Hour)
	if code := me(short); code != http.StatusUnauthorized {
		t.Errorf("short session after 13 idle hours: %d", code)
	}
	if code := me(long); code != http.StatusOK {
		t.Errorf("remembered session after 13 idle hours: %d", code)
	}
	// the request slid the remembered session forward
	var seen string
	s.DB.QueryRow(`SELECT last_seen FROM sessions WHERE token_hash = ?`, auth.TokenHash(long.Value)).Scan(&seen)
	if ts, _ := time.Parse(time.RFC3339, seen); time.Since(ts) > time.Minute {
		t.Errorf("last_seen not renewed: %q", seen)
	}
	setSeen(long, 31*24*time.Hour)
	if code := me(long); code != http.StatusUnauthorized {
		t.Errorf("remembered session after 31 idle days: %d", code)
	}

	// a session from before the column: in, and stamped
	old := start(true)
	setSeen(old, 0)
	s.DB.Exec(`UPDATE sessions SET ip = '' WHERE token_hash = ?`, auth.TokenHash(old.Value))
	if code := me(old); code != http.StatusOK {
		t.Errorf("pre-column session: %d", code)
	}
	var ip string
	s.DB.QueryRow(`SELECT last_seen, ip FROM sessions WHERE token_hash = ?`, auth.TokenHash(old.Value)).Scan(&seen, &ip)
	if seen == "" || ip == "" {
		t.Errorf("pre-column session not stamped: seen %q, ip %q", seen, ip)
	}
}

// A new address is stored with the next request, not only with the next
// last_seen stamp, and the list says when each session ends unless used: the
// hard expiry or the end of the idle window, whichever comes first.
func TestSessionAddressAndEnd(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	rec := httptest.NewRecorder()
	if err := auth.CreateSession(s.DB, rec, httptest.NewRequest("GET", "/", nil), userID, false); err != nil {
		t.Fatal(err)
	}
	c := rec.Result().Cookies()[0]
	seen := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	s.DB.Exec(`UPDATE sessions SET last_seen = ?, ip = '203.0.113.9' WHERE token_hash = ?`, seen, auth.TokenHash(c.Value))

	if code := doReq(mux, "GET", "/api/auth/me", "", c).Code; code != http.StatusOK {
		t.Fatalf("me: %d", code)
	}
	var ip, stamp string
	s.DB.QueryRow(`SELECT ip, last_seen FROM sessions WHERE token_hash = ?`, auth.TokenHash(c.Value)).Scan(&ip, &stamp)
	if ip == "203.0.113.9" {
		t.Errorf("address not updated after a network change")
	}

	ts, _ := time.Parse(time.RFC3339, stamp)
	far := time.Now().Add(23 * time.Hour).UTC().Format(time.RFC3339)
	if got, want := auth.SessionEnd(far, stamp, false), ts.Add(12*time.Hour).UTC().Format(time.RFC3339); got != want {
		t.Errorf("idle end: got %s, want %s", got, want)
	}
	hard := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if got := auth.SessionEnd(hard, stamp, false); got != hard {
		t.Errorf("hard end: got %s, want %s", got, hard)
	}
	if body := doReq(mux, "GET", "/api/auth/sessions", "", c).Body.String(); !strings.Contains(body, `"endsAt":"`) {
		t.Errorf("list without endsAt: %s", body)
	}
}
