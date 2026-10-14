package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A wrong password says how many attempts are left before the pause and how
// long the pause is; inside a trusted network there is no count.
func TestLoginRefusedCountsAttempts(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)
	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"a@example.com","password":"longenough123"}`, nil); rec.Code != http.StatusCreated {
		t.Fatalf("register: got %d: %s", rec.Code, rec.Body)
	}
	refused := func() LoginRefusedResponse {
		t.Helper()
		rec := doReq(mux, "POST", "/api/auth/login", `{"email":"a@example.com","password":"wrong-password"}`, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("login: got %d: %s", rec.Code, rec.Body)
		}
		var out LoginRefusedResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := refused()
	if first.AttemptsLeft == nil || first.PauseSeconds != 12 {
		t.Fatalf("first refusal: %+v", first)
	}
	// register and this login spent two of the five
	if *first.AttemptsLeft != 3 {
		t.Errorf("attempts left: got %d, want 3", *first.AttemptsLeft)
	}
	if second := refused(); second.AttemptsLeft == nil || *second.AttemptsLeft != *first.AttemptsLeft-1 {
		t.Errorf("second refusal did not count down: %+v", second)
	}
	// an unknown email counts the same, so it reveals nothing
	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"b@example.com","password":"wrong-password"}`, nil)
	if !strings.Contains(rec.Body.String(), `"attemptsLeft":1`) {
		t.Errorf("unknown email: %s", rec.Body)
	}

	if err := db.SetSetting(d, "trusted_networks", "192.0.2.0/24"); err != nil {
		t.Fatal(err)
	}
	if out := refused(); out.AttemptsLeft != nil || out.PauseSeconds != 0 {
		t.Errorf("trusted network: got a count %+v", out)
	}
}

// loginFrom posts a login from the given client address.
func loginFrom(mux *http.ServeMux, ip, email, pw string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"email":"`+email+`","password":"`+pw+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = net.JoinHostPort(ip, "40000")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// Guesses spread over many addresses still run into the account's own
// budget; an unknown address behaves the same, and a trusted network is the
// owner's way back in.
func TestAccountLimiter(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, OIDC: auth.NewManager(context.Background(), d)}
	mux := http.NewServeMux()
	s.Register(mux)
	if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"a@example.com","password":"longenough123"}`, nil); rec.Code != http.StatusCreated {
		t.Fatalf("register: got %d: %s", rec.Code, rec.Body)
	}
	for _, email := range []string{"a@example.com", "nobody@example.com"} {
		for i := 0; i < 10; i++ {
			if rec := loginFrom(mux, "198.51.100."+strconv.Itoa(i+1), email, "wrong-password"); rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s attempt %d: got %d: %s", email, i, rec.Code, rec.Body)
			}
		}
		rec := loginFrom(mux, "203.0.113.50", email, "longenough123")
		if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
			t.Errorf("%s from a fresh address after ten failures: got %d", email, rec.Code)
		}
	}
	if err := db.SetSetting(d, "trusted_networks", "10.0.0.0/8"); err != nil {
		t.Fatal(err)
	}
	if rec := loginFrom(mux, "10.1.2.3", "a@example.com", "longenough123"); rec.Code != http.StatusOK {
		t.Fatalf("owner from the trusted network: got %d: %s", rec.Code, rec.Body)
	}
	// the sign-in cleared the account's failures for everyone
	if rec := loginFrom(mux, "203.0.113.51", "a@example.com", "longenough123"); rec.Code != http.StatusOK {
		t.Errorf("after a successful sign-in: got %d: %s", rec.Code, rec.Body)
	}
}

// One IPv6 /64 is one bucket; IPv4 and v4-mapped stay per address.
func TestLimitKey(t *testing.T) {
	for in, want := range map[string]string{
		"2001:db8:1:2:aaaa::1":  "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::99": "2001:db8:1:2::/64",
		"192.0.2.7":             "192.0.2.7",
		"::ffff:192.0.2.7":      "::ffff:192.0.2.7",
		"not-an-ip":             "not-an-ip",
	} {
		if got := limitKey(in); got != want {
			t.Errorf("limitKey(%q) = %q, want %q", in, got, want)
		}
	}
}

// The sweep drops buckets that are back at full tokens, however young, and
// keeps a drained one, however many one-hit peers pile up around it.
func TestIPLimiterSweepKeepsBlockedBuckets(t *testing.T) {
	l := newIPLimiter(5, 5, nil)
	blocked := &ipEntry{lim: rate.NewLimiter(l.rate, l.burst)}
	for i := 0; i < 5; i++ {
		blocked.lim.Allow()
	}
	l.ips["10.0.0.1"] = blocked
	for i := 0; i < 10001; i++ {
		l.ips["198.51.100."+strings.Repeat("x", i%7)+string(rune('a'+i%26))+strings.Repeat("y", i/26)] = &ipEntry{lim: rate.NewLimiter(l.rate, l.burst)}
	}
	l.allow("203.0.113.1")
	if len(l.ips) > 2 {
		t.Fatalf("sweep left %d buckets", len(l.ips))
	}
	if _, ok := l.ips["10.0.0.1"]; !ok {
		t.Fatal("sweep dropped the blocked bucket")
	}
	if l.allow("10.0.0.1") {
		t.Fatal("blocked address got through after the sweep")
	}
}
