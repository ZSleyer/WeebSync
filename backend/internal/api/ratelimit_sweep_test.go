package api

import (
	"strconv"
	"testing"

	"golang.org/x/time/rate"
)

// A flood of addresses that each drain their bucket leaves nothing a sweep
// can drop. Sweeping the whole map on every new address then made each
// request O(n) under the global lock; the sweeps must stay amortised O(1)
// per new key.
func TestIPLimiterSweepAmortised(t *testing.T) {
	l := newIPLimiter(0.001, 1, nil)
	l.sweepAt = 100
	const keys = 20000
	for i := range keys {
		ip := "10.0." + strconv.Itoa(i/250) + "." + strconv.Itoa(i%250)
		l.take(ip) // spends the only token: the bucket stays drained
	}
	if len(l.ips) != keys {
		t.Fatalf("tracked %d keys, want %d (drained buckets must stay)", len(l.ips), keys)
	}
	if l.sweepVisits > 4*keys {
		t.Fatalf("sweeps looked at %d buckets for %d new keys, want at most %d", l.sweepVisits, keys, 4*keys)
	}
	// a drained address stays blocked through the flood
	if ok, _ := l.take("10.0.0.0"); ok {
		t.Error("a drained bucket was swept away")
	}
}

// Buckets back at full tokens still go once the map passes the threshold.
func TestIPLimiterSweepDropsFullBuckets(t *testing.T) {
	l := newIPLimiter(60000, 1, nil) // refills within a millisecond
	l.sweepAt = 10
	for i := range 11 {
		l.ips["k"+strconv.Itoa(i)] = &ipEntry{lim: rate.NewLimiter(l.rate, l.burst)}
	}
	l.take("new")
	if len(l.ips) != 1 {
		t.Fatalf("after a sweep %d buckets left, want only the new one", len(l.ips))
	}
}
