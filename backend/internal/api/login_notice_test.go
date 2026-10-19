package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/secret"
)

const firefoxLinux = "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0"

type loginNoticeRig struct {
	mux    *http.ServeMux
	s      *Server
	userID int64
	mails  chan string
	pushes chan push.Notification
}

// newLoginNoticeRig is a server with mail on, a user who has signed in
// before (so the first-sign-in rule is out of the way) and capture seams.
func newLoginNoticeRig(t *testing.T) *loginNoticeRig {
	t.Helper()
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	setPassword(t, s, userID, "correct horse battery")
	if _, err := s.DB.Exec(`UPDATE users SET email_verified = 1, signed_in_before = 1, locale = 'en' WHERE id = ?`, userID); err != nil {
		t.Fatal(err)
	}
	g := &loginNoticeRig{mux: mux, s: s, userID: userID, mails: make(chan string, 8), pushes: make(chan push.Notification, 8)}
	s.securityMail = func(_, subject, text, _ string) error {
		g.mails <- subject + "\n" + text
		return nil
	}
	s.securityPush = func(_ int64, n push.Notification) { g.pushes <- n }
	return g
}

func (g *loginNoticeRig) login(t *testing.T, ua string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return g.loginFrom(t, "203.0.113.7:4000", ua, cookies...)
}

func (g *loginNoticeRig) loginFrom(t *testing.T, addr, ua string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"email":"user@example.com","password":"correct horse battery"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	req.RemoteAddr = addr
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	g.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	return rec
}

func (g *loginNoticeRig) expectMail(t *testing.T) string {
	t.Helper()
	select {
	case m := <-g.mails:
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("no login notice sent")
		return ""
	}
}

// expectNone waits for the background sends to end, then checks nothing came.
func (g *loginNoticeRig) expectNone(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	g.s.Shutdown(ctx)
	select {
	case m := <-g.mails:
		t.Errorf("unexpected mail: %s", m)
	case n := <-g.pushes:
		t.Errorf("unexpected push: %+v", n)
	default:
	}
}

func TestLoginNoticeNewDevice(t *testing.T) {
	g := newLoginNoticeRig(t)
	rec := g.login(t, firefoxLinux)
	m := g.expectMail(t)
	for _, want := range []string{"New sign-in to WeebSync", "Firefox · Linux", "203.0.113.7", "password", "Settings"} {
		if !strings.Contains(m, want) {
			t.Errorf("notice lacks %q: %s", want, m)
		}
	}
	if strings.Contains(m, "http") {
		t.Errorf("notice carries a link: %s", m)
	}
	c := cookieNamed(rec, knownCookie)
	if c == nil || c.Path != "/api/auth" || !c.HttpOnly || c.MaxAge != 400*24*3600 {
		t.Fatalf("known cookie: %+v", c)
	}
	// the same browser again: no second notice, and the entry stays
	rec = g.login(t, firefoxLinux, c)
	g.expectNone(t)
	if c2 := cookieNamed(rec, knownCookie); c2 == nil || c2.Value != c.Value {
		t.Errorf("refreshed cookie changed: %+v", c2)
	}
}

func TestLoginNoticeForgedOrForeignCookie(t *testing.T) {
	g := newLoginNoticeRig(t)
	rec := g.login(t, firefoxLinux)
	g.expectMail(t)
	good := cookieNamed(rec, knownCookie)

	// the MAC of another user's entry does not carry over
	parts := strings.Split(good.Value, ".")
	foreign := &http.Cookie{Name: knownCookie, Value: "999." + parts[1] + "." + parts[2]}
	forged := &http.Cookie{Name: knownCookie, Value: parts[0] + "." + parts[1] + "." + strings.Repeat("0", 64)}
	for _, c := range []*http.Cookie{foreign, forged} {
		// reset the throttle: it is the cookie that is under test
		g.s.loginNoticeLimiter = newIPLimiter(1.0/600, 1, nil)
		g.login(t, firefoxLinux, c)
		g.expectMail(t)
	}
}

func TestLoginNoticeThrottle(t *testing.T) {
	g := newLoginNoticeRig(t)
	g.login(t, firefoxLinux)
	g.expectMail(t)
	g.login(t, "Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537.36")
	g.expectNone(t)
	// the window is ten minutes, not ten hours: the limiter takes a rate
	// per minute
	ok, wait := g.s.loginNoticeLimiter.take("login-notice:" + strconv.FormatInt(g.userID, 10) + "|203.0.113.7")
	if ok || wait > 10*time.Minute || wait < 9*time.Minute {
		t.Errorf("throttle: allowed %v, next notice in %v; want about ten minutes", ok, wait)
	}
	// a new browser from another address inside the window is still reported:
	// the throttle must not let a stranger in quietly behind the owner
	g.loginFrom(t, "198.51.100.9:4000", "Mozilla/5.0 (Macintosh; Mac OS X 14_0) Safari/605.1.15")
	g.expectMail(t)
}

func TestLoginNoticeFirstSignIn(t *testing.T) {
	g := newLoginNoticeRig(t)
	if _, err := g.s.DB.Exec(`UPDATE users SET signed_in_before = 0 WHERE id = ?`, g.userID); err != nil {
		t.Fatal(err)
	}
	rec := g.login(t, firefoxLinux)
	g.expectNone(t)
	if cookieNamed(rec, knownCookie) == nil {
		t.Error("first sign-in did not remember the browser")
	}
	// a second browser is then new
	g.login(t, firefoxLinux)
	g.expectMail(t)
}

func TestLoginNoticePushWithoutMail(t *testing.T) {
	g := newLoginNoticeRig(t)
	db.SetSetting(g.s.DB, "smtp_host", "")
	if _, err := g.s.DB.Exec(`UPDATE users SET locale = 'de' WHERE id = ?`, g.userID); err != nil {
		t.Fatal(err)
	}
	g.login(t, firefoxLinux)
	select {
	case n := <-g.pushes:
		if n.Title != "Neue Anmeldung bei WeebSync" || n.Tag != "login-notice" || n.URL != "/settings/account" || !strings.Contains(n.Body, "Firefox · Linux") {
			t.Errorf("push: %+v", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no push")
	}
	g.expectNone(t)
}

func TestLoginNoticeMailPreferredOverPush(t *testing.T) {
	g := newLoginNoticeRig(t)
	g.login(t, firefoxLinux)
	g.expectMail(t)
	g.expectNone(t)
}

func TestLoginNoticeNothingToSendWith(t *testing.T) {
	g := newLoginNoticeRig(t)
	g.s.securityPush = nil
	g.s.Push = nil
	db.SetSetting(g.s.DB, "smtp_host", "")
	g.login(t, firefoxLinux)
	g.expectNone(t) // a log line only
}

func TestEnrollKnownOnMeIsQuiet(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, userC, _, _ := setupUsersTest(t)
	s.securityMail = func(_, _, _, _ string) error { t.Error("mail on enrolment"); return nil }
	rec := doReq(mux, "GET", "/api/auth/me", "", userC)
	c := cookieNamed(rec, knownCookie)
	if rec.Code != http.StatusOK || c == nil {
		t.Fatalf("me: %d cookie %v", rec.Code, c)
	}
	// carrying the entry already: no new cookie
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(userC)
	req.AddCookie(c)
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req)
	if cookieNamed(rec2, knownCookie) != nil {
		t.Error("cookie rewritten for an enrolled browser")
	}
}

// The hook the OIDC callback calls goes through the same path.
func TestLoginNoticeSSOHook(t *testing.T) {
	g := newLoginNoticeRig(t)
	req := httptest.NewRequest("GET", "/api/auth/oidc/callback", nil)
	req.Header.Set("User-Agent", firefoxLinux)
	g.s.signInAlert(httptest.NewRecorder(), req, g.userID, signInSSO)
	if m := g.expectMail(t); !strings.Contains(m, "Method: SSO") {
		t.Errorf("method missing: %s", m)
	}
}

func TestParseKnownMalformed(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	good := knownEntry{uid: 7, nonce: strings.Repeat("ab", 16)}.String()
	if got := parseKnown(good); len(got) != 1 || got[0].uid != 7 {
		t.Fatalf("good entry: %+v", got)
	}
	hex32, hex64 := strings.Repeat("a", 32), strings.Repeat("b", 64)
	for _, v := range []string{
		"", "~", "~~~", ".", "..", "x", "7", "7.a.b", "7." + hex32, "7." + hex32 + "." + hex64,
		"-7." + hex32 + "." + hex64, "+7." + hex32 + "." + hex64, "7a." + hex32 + "." + hex64,
		".7." + hex32 + "." + hex64, "99999999999999999999." + hex32 + "." + hex64,
		"7." + strings.Repeat("g", 32) + "." + hex64, "7." + hex32 + "." + strings.Repeat("g", 64),
		"7." + hex32 + "." + hex64 + ".extra", string([]byte{0, 1, 2}),
	} {
		if got := parseKnown(v); len(got) != 0 {
			t.Errorf("parseKnown(%q) = %+v", v, got)
		}
	}
	// a bad entry does not spoil the good one beside it
	if got := parseKnown("junk~" + good + "~7.x.y"); len(got) != 1 {
		t.Errorf("mixed: %+v", got)
	}
	// only the first four count
	if got := parseKnown(strings.Repeat(good+"~", 6)); len(got) != knownEntries {
		t.Errorf("cap: %d", len(got))
	}
}

func TestBrowserName(t *testing.T) {
	for ua, want := range map[string]string{
		"":           "",
		firefoxLinux: "Firefox · Linux",
		"Mozilla/5.0 (Windows NT 10.0) Chrome/150 Safari/537 Edg/150":       "Edge · Windows",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17 like Mac OS X) Safari/604.1": "Safari · iOS",
		"curl/8.0": "curl/8.0",
	} {
		if got := browserName(ua); got != want {
			t.Errorf("browserName(%q) = %q, want %q", ua, got, want)
		}
	}
}
