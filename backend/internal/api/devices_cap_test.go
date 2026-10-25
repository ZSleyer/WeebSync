package api

import (
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

func (dt *deviceTest) pairFrom(ip string) int {
	return dt.do("POST", "/api/devices/pair", `{}`, nil, "", ip).Code
}

// One source cannot hold the pairing table: a few open pairings per address
// (IPv4 or IPv6 /64), a few more per IPv6 /48, and approved or denied rows
// do not count as open.
func TestPairingCapsPerSource(t *testing.T) {
	t.Run("per address", func(t *testing.T) {
		dt := newDeviceTest(t)
		got := 0
		for i := range 8 {
			if code := dt.pairFrom(fmt.Sprintf("2001:db8:5:1::%x", i+1)); code != http.StatusOK {
				break
			}
			got++
		}
		if got != maxPendingPerSource {
			t.Errorf("one /64 opened %d pairings, want %d", got, maxPendingPerSource)
		}
		if code := dt.pairFrom("192.0.2.200"); code != http.StatusOK {
			t.Errorf("another address: %d", code)
		}
	})
	t.Run("per /48", func(t *testing.T) {
		dt := newDeviceTest(t)
		got := 0
		for i := range 200 {
			// a fresh /64 each time, all inside 2001:db8:7::/48
			if code := dt.pairFrom(fmt.Sprintf("2001:db8:7:%x::1", i+1)); code == http.StatusOK {
				got++
			}
		}
		if got > maxPendingPerWide {
			t.Errorf("one /48 opened %d pairings, want at most %d", got, maxPendingPerWide)
		}
		if code := dt.pairFrom("2001:db8:8::1"); code != http.StatusOK {
			t.Errorf("a fresh address after the /48 filled up: %d, want 200", code)
		}
	})
	t.Run("settled rows do not count", func(t *testing.T) {
		dt := newDeviceTest(t)
		for i := range maxPendingPerSource {
			p := dt.pair("")
			_ = i
			if rec := dt.approve(dt.alice, p.UserCode, ""); rec.Code != http.StatusOK {
				t.Fatalf("approve: %d", rec.Code)
			}
		}
		if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET source = 'x', source_wide = 'x'`); err != nil {
			t.Fatal(err)
		}
		old := pendingPairingCap
		pendingPairingCap = 2
		t.Cleanup(func() { pendingPairingCap = old })
		if code := dt.pairFrom("192.0.2.201"); code != http.StatusOK {
			t.Errorf("with only approved rows open: %d, want 200", code)
		}
	})
}

// A burst from one source cannot slip past its share between the count and
// the insert: the two run as one transaction.
func TestPairingCapHoldsUnderConcurrency(t *testing.T) {
	dt := newDeviceTest(t)
	// a trusted network skips the address limiter, so only the cap holds
	if err := db.SetSetting(dt.s.DB, "trusted_networks", "192.0.2.0/24"); err != nil {
		t.Fatal(err)
	}
	const n = 40
	codes := make(chan int, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range n {
		wg.Go(func() {
			<-start
			codes <- dt.pairFrom("192.0.2.99")
		})
	}
	close(start)
	wg.Wait()
	close(codes)
	ok := 0
	for c := range codes {
		if c == http.StatusOK {
			ok++
		}
	}
	var rows int
	if err := dt.s.DB.QueryRow(`SELECT COUNT(*) FROM device_pairings`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if ok > maxPendingPerSource || rows > maxPendingPerSource {
		t.Errorf("%d concurrent pairings from one address: %d answered 200, %d rows; want at most %d", n, ok, rows, maxPendingPerSource)
	}
}

// Stale is measured from the last sign of life against the row's own
// interval: polled once and then silent is evictable, a TV slowed to 60 s
// that keeps polling at that pace is not.
func TestPairingEvictsByStaleness(t *testing.T) {
	dt := newDeviceTest(t)
	old := pendingPairingCap
	pendingPairingCap = 2
	t.Cleanup(func() { pendingPairingCap = old })
	silent, slowed := dt.pair(""), dt.pair("")
	nowMs := time.Now().UnixMilli()
	set := func(code pairOut, interval int, lastPollAgo time.Duration) {
		t.Helper()
		if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET created_at = created_at - 300, poll_interval = ?, last_poll_ms = ?
			WHERE device_code_hash = ?`, interval, nowMs-lastPollAgo.Milliseconds(), auth.TokenHash(code.DeviceCode)); err != nil {
			t.Fatal(err)
		}
	}
	set(silent, 5, time.Minute)     // one poll a minute ago, nothing since
	set(slowed, 60, 70*time.Second) // inside 2 × 60 s + 5 s
	if code := dt.pairFrom("192.0.2.220"); code != http.StatusOK {
		t.Fatalf("at the cap with a silent pairing: %d, want 200", code)
	}
	left := func(code pairOut) bool {
		var n int
		if err := dt.s.DB.QueryRow(`SELECT COUNT(*) FROM device_pairings WHERE device_code_hash = ?`, auth.TokenHash(code.DeviceCode)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	if left(silent) {
		t.Error("the pairing polled once and then silent was not evicted")
	}
	if !left(slowed) {
		t.Error("the slowed pairing polling at its interval was evicted")
	}
}

// A deny that loses the race (the pairing was approved between the lookup
// and the write) says so instead of reporting a refusal that did not happen.
func TestDeviceDenyLosingTheRace(t *testing.T) {
	dt := newDeviceTest(t)
	p := dt.pair("")
	// the approval lands in between: the deny's write finds no pending row
	if _, err := dt.s.DB.Exec(`CREATE TEMP TRIGGER approve_first BEFORE UPDATE OF status ON device_pairings
		WHEN NEW.status = 'denied' BEGIN SELECT RAISE(IGNORE); END`); err != nil {
		t.Fatal(err)
	}
	rec := dt.do("POST", "/api/devices/deny", fmt.Sprintf(`{"userCode":%q}`, p.UserCode), dt.alice, "", dt.freshIP())
	if rec.Code != http.StatusNotFound {
		t.Errorf("deny that changed nothing: %d %s, want 404", rec.Code, rec.Body)
	}
}

// At the global cap the oldest pairings no device ever polled make room; only
// when every open pairing is in use is a new one refused.
func TestPairingGlobalCapEvicts(t *testing.T) {
	dt := newDeviceTest(t)
	old := pendingPairingCap
	pendingPairingCap = 10
	t.Cleanup(func() { pendingPairingCap = old })
	var codes []pairOut
	for range 10 {
		codes = append(codes, dt.pair(""))
	}
	// all old enough to be abandoned unless polled
	if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET created_at = created_at - 60`); err != nil {
		t.Fatal(err)
	}
	// the first one is a real TV: it polls
	if code, out := dt.pollNow(codes[0].DeviceCode); out.Error != "authorization_pending" {
		t.Fatalf("poll: %d %+v", code, out)
	}
	if code := dt.pairFrom("192.0.2.210"); code != http.StatusOK {
		t.Fatalf("at the cap with abandoned rows: %d, want 200", code)
	}
	if code, out := dt.poll(codes[0].DeviceCode); out.Error != "authorization_pending" {
		t.Errorf("the polled pairing was evicted: %d %+v", code, out)
	}
	if code, out := dt.poll(codes[1].DeviceCode); out.Error != "invalid_grant" {
		t.Errorf("the oldest abandoned pairing survived: %d %+v", code, out)
	}
	// fresh rows are not evicted: a TV gets its interval to poll first
	if _, err := dt.s.DB.Exec(`UPDATE device_pairings SET created_at = ?, last_poll_ms = 0`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if code := dt.pairFrom("192.0.2.211"); code != http.StatusTooManyRequests {
		t.Errorf("at the cap with only fresh rows: %d, want 429", code)
	}
}
