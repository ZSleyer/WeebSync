package api

import (
	"context"
	"encoding/json"
	"net/http"
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
