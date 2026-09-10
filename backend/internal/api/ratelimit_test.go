package api

import (
	"strings"
	"testing"

	"golang.org/x/time/rate"
)

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
