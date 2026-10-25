package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

// deviceTest is a server with two plain users and an admin, each signed in.
type deviceTest struct {
	t      *testing.T
	s      *Server
	mux    *http.ServeMux
	alice  *http.Cookie // user 1
	bob    *http.Cookie // user 2
	admin  *http.Cookie // user 3
	nextIP int
}

func newDeviceTest(t *testing.T) *deviceTest {
	t.Helper()
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, OIDC: auth.NewManager(context.Background(), d), Anilist: anilist.New(d), Tmdb: tmdb.New(d)})
	mux := http.NewServeMux()
	s.Register(mux)
	// a route behind the device-token gate alone, whatever /api/tv/* serves
	mux.Handle("GET /api/tv/probe", s.tvAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, OkResponse{Status: tvUser(r.Context()).Email})
	}))
	if _, err := d.Exec(`INSERT INTO users (id, email, is_admin) VALUES
		(1, 'alice@example.com', 0), (2, 'bob@example.com', 0), (3, 'admin@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	login := func(id int64) *http.Cookie {
		t.Helper()
		rec := httptest.NewRecorder()
		if err := auth.CreateSession(d, rec, httptest.NewRequest("POST", "/", nil), id, true); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0]
	}
	return &deviceTest{t: t, s: s, mux: mux, alice: login(1), bob: login(2), admin: login(3)}
}

// do sends a request from ip (empty: the default test address) with an
// optional cookie and bearer token.
func (dt *deviceTest) do(method, path, body string, c *http.Cookie, bearer, ip string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		req.AddCookie(c)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if ip != "" {
		req.RemoteAddr = ip + ":4000"
	}
	rec := httptest.NewRecorder()
	dt.mux.ServeHTTP(rec, req)
	return rec
}

// freshIP hands out a new address so one test's limiter budget does not run
// into the next step's.
func (dt *deviceTest) freshIP() string {
	dt.nextIP++
	return fmt.Sprintf("198.51.100.%d", dt.nextIP)
}

type pairOut struct {
	UserCode   string `json:"userCode"`
	DeviceCode string `json:"deviceCode"`
	ExpiresAt  int64  `json:"expiresAt"`
	Interval   int    `json:"interval"`
}

type tokenOut struct {
	Token    string `json:"token"`
	Scope    string `json:"scope"`
	Error    string `json:"error"`
	Interval int    `json:"interval"`
}

func (dt *deviceTest) pair(name string) pairOut {
	dt.t.Helper()
	body := ""
	if name != "" {
		body = fmt.Sprintf(`{"name":%q}`, name)
	}
	rec := dt.do("POST", "/api/devices/pair", body, nil, "", dt.freshIP())
	if rec.Code != http.StatusOK {
		dt.t.Fatalf("pair: %d %s", rec.Code, rec.Body)
	}
	var p pairOut
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		dt.t.Fatal(err)
	}
	return p
}

// poll asks for the token, first moving the last poll back so the interval
// is kept.
func (dt *deviceTest) poll(deviceCode string) (int, tokenOut) {
	dt.t.Helper()
	dt.backdatePoll()
	return dt.pollNow(deviceCode)
}

func (dt *deviceTest) pollNow(deviceCode string) (int, tokenOut) {
	dt.t.Helper()
	rec := dt.do("POST", "/api/devices/token", fmt.Sprintf(`{"deviceCode":%q}`, deviceCode), nil, "", "203.0.113.7")
	var out tokenOut
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		dt.t.Fatalf("token body %q: %v", rec.Body, err)
	}
	return rec.Code, out
}

func (dt *deviceTest) backdatePoll() {
	dt.t.Helper()
	if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET last_poll_ms = last_poll_ms - 3600000 WHERE last_poll_ms > 0`); err != nil {
		dt.t.Fatal(err)
	}
}

func (dt *deviceTest) approve(c *http.Cookie, userCode, name string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"userCode":%q}`, userCode)
	if name != "" {
		body = fmt.Sprintf(`{"userCode":%q,"name":%q}`, userCode, name)
	}
	return dt.do("POST", "/api/devices/approve", body, c, "", dt.freshIP())
}

// link runs the whole pairing for the user behind c and returns the token.
func (dt *deviceTest) link(c *http.Cookie, name string) string {
	dt.t.Helper()
	p := dt.pair(name)
	if rec := dt.approve(c, p.UserCode, ""); rec.Code != http.StatusOK {
		dt.t.Fatalf("approve: %d %s", rec.Code, rec.Body)
	}
	code, out := dt.poll(p.DeviceCode)
	if code != http.StatusOK || out.Token == "" {
		dt.t.Fatalf("token after approval: %d %+v", code, out)
	}
	return out.Token
}

var userCodeRe = regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`)

// The whole RFC 8628 round: pair, poll while pending, approve by the typed
// code, the token once, then never again; only hashes are stored.
func TestDevicePairingFlow(t *testing.T) {
	dt := newDeviceTest(t)
	p := dt.pair("Kotatsu Wohnzimmer")
	if !userCodeRe.MatchString(p.UserCode) {
		t.Errorf("user code %q is not XXXX-XXXX in the base-20 set", p.UserCode)
	}
	if len(p.DeviceCode) < 43 {
		t.Errorf("device code %q is too short for a high-entropy secret", p.DeviceCode)
	}
	if left := time.Until(time.Unix(p.ExpiresAt, 0)); left < 9*time.Minute || left > 11*time.Minute {
		t.Errorf("expires in %v, want about 10 minutes", left)
	}
	if p.Interval != 5 {
		t.Errorf("interval %d, want 5", p.Interval)
	}
	// nothing secret at rest
	var raw string
	if err := dt.s.DB.QueryRow(`SELECT device_code_hash || '|' || user_code_hash FROM device_pairings`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, p.DeviceCode) || strings.Contains(raw, strings.ReplaceAll(p.UserCode, "-", "")) {
		t.Errorf("pairing row holds a code in the clear: %q", raw)
	}

	code, out := dt.poll(p.DeviceCode)
	if code != http.StatusBadRequest || out.Error != "authorization_pending" {
		t.Fatalf("pending poll: %d %+v", code, out)
	}
	// typed lower case, without the dash and with a stray space: still the code
	typed := " " + strings.ToLower(strings.ReplaceAll(p.UserCode, "-", ""))
	rec := dt.approve(dt.alice, typed, "Wohnzimmer")
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body)
	}
	var ap struct {
		Name string `json:"name"`
	}
	json.Unmarshal(rec.Body.Bytes(), &ap)
	if ap.Name != "Wohnzimmer" {
		t.Errorf("approve answered name %q, want the one given", ap.Name)
	}
	// the code is used up: approving it again finds nothing
	if rec := dt.approve(dt.bob, p.UserCode, ""); rec.Code != http.StatusNotFound {
		t.Errorf("second approval by someone else: %d, want 404", rec.Code)
	}

	code, out = dt.poll(p.DeviceCode)
	if code != http.StatusOK || out.Token == "" || out.Scope != "tv:read" {
		t.Fatalf("token: %d %+v", code, out)
	}
	// once only: the device code is consumed
	code, again := dt.poll(p.DeviceCode)
	if code != http.StatusBadRequest || again.Token != "" || again.Error != "invalid_grant" {
		t.Errorf("second token request: %d %+v, want 400 invalid_grant", code, again)
	}
	var n int
	if err := dt.s.DB.QueryRow(`SELECT COUNT(*) FROM device_pairings`).Scan(&n); err != nil || n != 0 {
		t.Errorf("pairing rows left: %d (%v), want the consumed one gone", n, err)
	}
	var hash, name string
	var uid int64
	if err := dt.s.DB.QueryRow(`SELECT token_hash, name, user_id FROM device_tokens`).Scan(&hash, &name, &uid); err != nil {
		t.Fatal(err)
	}
	if hash == out.Token || hash != auth.TokenHash(out.Token) || uid != 1 || name != "Wohnzimmer" {
		t.Errorf("stored token = %q/%q/%d, want only the hash, bound to alice, named", hash, name, uid)
	}

	// the token reads the tv routes of its user
	if rec := dt.do("GET", "/api/tv/probe", "", nil, out.Token, ""); rec.Code != http.StatusOK {
		t.Errorf("calendar with the new token: %d %s", rec.Code, rec.Body)
	}
}

// What the token endpoint answers in each state, in the API's {"error": …}
// body with the RFC's error codes.
func TestDeviceTokenStates(t *testing.T) {
	dt := newDeviceTest(t)

	t.Run("slow_down", func(t *testing.T) {
		p := dt.pair("")
		if code, out := dt.pollNow(p.DeviceCode); code != http.StatusBadRequest || out.Error != "authorization_pending" {
			t.Fatalf("first poll: %d %+v", code, out)
		}
		code, out := dt.pollNow(p.DeviceCode)
		if code != http.StatusBadRequest || out.Error != "slow_down" || out.Interval != 10 {
			t.Fatalf("poll inside the interval: %d %+v, want slow_down with interval 10", code, out)
		}
		// the new interval holds from now on
		if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET last_poll_ms = last_poll_ms - 7000`); err != nil {
			t.Fatal(err)
		}
		if code, out := dt.pollNow(p.DeviceCode); out.Error != "slow_down" {
			t.Errorf("7 s after a slow_down to 10 s: %d %+v, want slow_down", code, out)
		}
	})

	t.Run("expired", func(t *testing.T) {
		p := dt.pair("")
		if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET expires_at = ?`, time.Now().Add(-time.Second).Unix()); err != nil {
			t.Fatal(err)
		}
		if code, out := dt.poll(p.DeviceCode); code != http.StatusBadRequest || out.Error != "expired_token" {
			t.Errorf("expired poll: %d %+v", code, out)
		}
		// an expired code cannot be approved either
		if rec := dt.approve(dt.alice, p.UserCode, ""); rec.Code != http.StatusNotFound {
			t.Errorf("approving an expired code: %d, want 404", rec.Code)
		}
	})

	t.Run("denied", func(t *testing.T) {
		p := dt.pair("")
		rec := dt.do("POST", "/api/devices/deny", fmt.Sprintf(`{"userCode":%q}`, p.UserCode), dt.alice, "", dt.freshIP())
		if rec.Code != http.StatusOK {
			t.Fatalf("deny: %d %s", rec.Code, rec.Body)
		}
		if code, out := dt.poll(p.DeviceCode); code != http.StatusBadRequest || out.Error != "access_denied" {
			t.Errorf("denied poll: %d %+v", code, out)
		}
		if code, out := dt.poll(p.DeviceCode); out.Error != "invalid_grant" {
			t.Errorf("after access_denied: %d %+v, want the code gone", code, out)
		}
	})

	t.Run("unknown and malformed", func(t *testing.T) {
		if code, out := dt.poll("not-a-code"); code != http.StatusBadRequest || out.Error != "invalid_grant" {
			t.Errorf("unknown device code: %d %+v", code, out)
		}
		rec := dt.do("POST", "/api/devices/token", `{}`, nil, "", "203.0.113.8")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_request") {
			t.Errorf("no device code: %d %s", rec.Code, rec.Body)
		}
		rec = dt.do("POST", "/api/devices/token", `deviceCode=x`, nil, "", "203.0.113.8")
		if rec.Code == http.StatusOK {
			t.Errorf("form body accepted")
		}
	})
}

// Approving needs a signed-in user and the exact code; there is no list of
// pending pairings to pick from.
func TestDeviceApproveGuards(t *testing.T) {
	dt := newDeviceTest(t)
	p := dt.pair("")
	if rec := dt.do("POST", "/api/devices/approve", fmt.Sprintf(`{"userCode":%q}`, p.UserCode), nil, "", dt.freshIP()); rec.Code != http.StatusUnauthorized {
		t.Errorf("approve without a session: %d, want 401", rec.Code)
	}
	for _, wrong := range []string{"BBBB-BBBB", "", "XYZ", "BCDF-GHJKL"} {
		if wrong == p.UserCode {
			continue
		}
		if rec := dt.approve(dt.alice, wrong, ""); rec.Code != http.StatusNotFound && rec.Code != http.StatusBadRequest {
			t.Errorf("wrong code %q: %d, want 404 or 400", wrong, rec.Code)
		}
	}
	if code, out := dt.poll(p.DeviceCode); out.Error != "authorization_pending" {
		t.Errorf("after wrong codes the pairing is %d %+v, want still pending", code, out)
	}
	for _, path := range []string{"/api/devices/pending", "/api/devices/pairings"} {
		if rec := dt.do("GET", path, "", dt.admin, "", ""); rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "userCode") {
			t.Errorf("%s lists pending pairings", path)
		}
	}
	if rec := dt.do("GET", "/api/devices", "", dt.admin, "", ""); strings.Contains(rec.Body.String(), "userCode") {
		t.Errorf("device list carries pending codes: %s", rec.Body)
	}
}

// Guessing user codes is held per address and, whatever the address, per
// account; the per-account limit has no trusted-network exemption.
func TestDeviceApproveRateLimits(t *testing.T) {
	t.Run("per account", func(t *testing.T) {
		dt := newDeviceTest(t)
		refused := 0
		for i := range 12 {
			if rec := dt.approve(dt.alice, "BBBB-BBBB", ""); rec.Code == http.StatusTooManyRequests {
				refused = i
				break
			}
		}
		if refused == 0 || refused > 10 {
			t.Fatalf("12 wrong codes from 12 addresses: refused at %d, want a per-account cap", refused)
		}
		// the cap holds the right code too: no oracle while blocked
		p := dt.pair("")
		if rec := dt.approve(dt.alice, p.UserCode, ""); rec.Code != http.StatusTooManyRequests {
			t.Errorf("right code while capped: %d, want 429", rec.Code)
		}
		// another account is not held by alice's guesses
		if rec := dt.approve(dt.bob, p.UserCode, ""); rec.Code != http.StatusOK {
			t.Errorf("bob: %d %s", rec.Code, rec.Body)
		}
	})
	t.Run("per address", func(t *testing.T) {
		dt := newDeviceTest(t)
		cookies := []*http.Cookie{dt.alice, dt.bob, dt.admin}
		got := 0
		for i := range 30 {
			rec := dt.do("POST", "/api/devices/approve", `{"userCode":"BBBB-BBBB"}`, cookies[i%3], "", "192.0.2.50")
			if rec.Code == http.StatusTooManyRequests {
				got = i
				break
			}
		}
		// three accounts take turns, so no account reaches its own cap
		// (five) before the 15th request: a refusal before that is the address's
		if got == 0 || got >= 15 {
			t.Errorf("approvals from one address refused at %d, want a per-address cap before 15", got)
		}
	})
	t.Run("pair and token per address", func(t *testing.T) {
		dt := newDeviceTest(t)
		limited := func(path, body string) bool {
			for range 60 {
				if rec := dt.do("POST", path, body, nil, "", "192.0.2.60"); rec.Code == http.StatusTooManyRequests {
					return true
				}
			}
			return false
		}
		if !limited("/api/devices/pair", `{}`) {
			t.Error("pair never refused one address")
		}
		if !limited("/api/devices/token", `{"deviceCode":"x"}`) {
			t.Error("token never refused one address")
		}
	})
}

// A device token opens the tv routes and nothing else.
func TestDeviceTokenOnlyOnTVRoutes(t *testing.T) {
	dt := newDeviceTest(t)
	tok := dt.link(dt.admin, "TV")
	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/status"},
		{"GET", "/api/watches"},
		{"GET", "/api/devices"},
		{"GET", "/api/auth/me"},
		{"GET", "/api/downloads"},
		{"POST", "/api/watches/1/check"},
	} {
		rec := dt.do(rt.method, rt.path, "", nil, tok, "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with a tv token: %d, want 401", rt.method, rt.path, rec.Code)
		}
	}
	for _, path := range tvPaths {
		if rec := dt.do("GET", path, "", nil, tok, ""); rec.Code != http.StatusOK {
			t.Errorf("%s with the token: %d %s", path, rec.Code, rec.Body)
		}
		if rec := dt.do("GET", path, "", nil, "", ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a token: %d, want 401", path, rec.Code)
		}
		if rec := dt.do("GET", path, "", nil, tok+"x", ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s with a wrong token: %d, want 401", path, rec.Code)
		}
		// a session cookie is not what the tv routes take
		if rec := dt.do("GET", path, "", dt.admin, "", ""); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s with a session cookie: %d, want 401", path, rec.Code)
		}
	}
	// a token with another scope is refused
	if _, err := dt.s.DB.Exec(`UPDATE device_tokens SET scope = 'other'`); err != nil {
		t.Fatal(err)
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, tok, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("token without tv:read: %d, want 401", rec.Code)
	}
}

// The owner lists and revokes their own devices; a revoked token, or one
// whose user is gone or unapproved, is refused; other users' devices are
// neither listed nor revocable.
func TestDeviceListRevokeCascade(t *testing.T) {
	dt := newDeviceTest(t)
	aliceTok := dt.link(dt.alice, "Alice TV")
	bobTok := dt.link(dt.bob, "Bob TV")
	adminTok := dt.link(dt.admin, "Admin TV")

	type dev struct {
		ID         int64  `json:"id"`
		Name       string `json:"name"`
		CreatedAt  string `json:"createdAt"`
		LastUsedAt string `json:"lastUsedAt"`
		LastIP     string `json:"lastIp"`
	}
	list := func(c *http.Cookie) []dev {
		t.Helper()
		rec := dt.do("GET", "/api/devices", "", c, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body)
		}
		var out []dev
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, aliceTok, "192.0.2.77"); rec.Code != http.StatusOK {
		t.Fatalf("calendar: %d", rec.Code)
	}
	al := list(dt.alice)
	if len(al) != 1 || al[0].Name != "Alice TV" || al[0].CreatedAt == "" || al[0].LastUsedAt == "" || al[0].LastIP != "192.0.2.77" {
		t.Fatalf("alice's devices = %+v, want her one TV with its last use", al)
	}
	if ad := list(dt.admin); len(ad) != 1 || ad[0].Name != "Admin TV" {
		t.Errorf("admin's list = %+v, want only the admin's own device", ad)
	}
	// bob cannot revoke alice's device
	if rec := dt.do("DELETE", fmt.Sprintf("/api/devices/%d", al[0].ID), "", dt.bob, "", ""); rec.Code != http.StatusNotFound {
		t.Errorf("bob revoking alice's device: %d, want 404", rec.Code)
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, aliceTok, ""); rec.Code != http.StatusOK {
		t.Errorf("alice's token after bob's try: %d", rec.Code)
	}
	if rec := dt.do("DELETE", fmt.Sprintf("/api/devices/%d", al[0].ID), "", dt.alice, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, aliceTok, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked token: %d, want 401", rec.Code)
	}
	if rec := dt.do("DELETE", fmt.Sprintf("/api/devices/%d", al[0].ID), "", dt.alice, "", ""); rec.Code != http.StatusNotFound {
		t.Errorf("revoking twice: %d, want 404", rec.Code)
	}
	if rec := dt.do("DELETE", "/api/devices/abc", "", dt.alice, "", ""); rec.Code != http.StatusNotFound && rec.Code != http.StatusBadRequest {
		t.Errorf("bad id: %d", rec.Code)
	}

	// an account set back to unapproved loses its devices' access
	if _, err := dt.s.DB.Exec(`UPDATE users SET approved = 0 WHERE id = 3`); err != nil {
		t.Fatal(err)
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, adminTok, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("token of an unapproved account: %d, want 401", rec.Code)
	}
	if _, err := dt.s.DB.Exec(`UPDATE users SET approved = 1 WHERE id = 3`); err != nil {
		t.Fatal(err)
	}

	// deleting bob takes his tokens with him
	if rec := dt.do("DELETE", "/api/users/2", "", dt.admin, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("delete bob: %d %s", rec.Code, rec.Body)
	}
	var n int
	if err := dt.s.DB.QueryRow(`SELECT COUNT(*) FROM device_tokens WHERE user_id = 2`).Scan(&n); err != nil || n != 0 {
		t.Errorf("bob's tokens after his deletion: %d (%v), want none", n, err)
	}
	if rec := dt.do("GET", "/api/tv/probe", "", nil, bobTok, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("deleted user's token: %d, want 401", rec.Code)
	}
}

// A user deleted while a pairing they approved waits for its poll leaves no
// token behind.
func TestDevicePairingOfDeletedUser(t *testing.T) {
	dt := newDeviceTest(t)
	p := dt.pair("")
	if rec := dt.approve(dt.bob, p.UserCode, ""); rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	if rec := dt.do("DELETE", "/api/users/2", "", dt.admin, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("delete bob: %d", rec.Code)
	}
	if code, out := dt.poll(p.DeviceCode); out.Token != "" || code == http.StatusOK {
		t.Errorf("poll after the approver was deleted: %d %+v, want no token", code, out)
	}
}

// The user code alphabet and its normalisation.
func TestUserCodeShape(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		c, err := newUserCode()
		if err != nil {
			t.Fatal(err)
		}
		if !userCodeRe.MatchString(c) {
			t.Fatalf("user code %q", c)
		}
		seen[c] = true
	}
	if len(seen) < 199 {
		t.Errorf("only %d distinct codes in 200", len(seen))
	}
	for in, want := range map[string]string{
		"WDJB-MJHT":    "WDJBMJHT",
		" wdjb mjht ":  "WDJBMJHT",
		"wdjb–mjht":    "WDJBMJHT",
		"WDJBMJH":      "",
		"WDJB-MJHTX":   "",
		"WDJB-MJH0":    "",
		"WDJA-MJHT":    "",
		"":             "",
		"ẂDJB-MJHT":    "",
		"wdjbmjhtwdjb": "",
	} {
		if got := normalizeUserCode(in); got != want {
			t.Errorf("normalizeUserCode(%q) = %q, want %q", in, got, want)
		}
	}
}

// tvPaths are the routes a device token opens.
var tvPaths = []string{"/api/tv/probe", "/api/tv/calendar", "/api/tv/recent"}
