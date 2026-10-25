package api

import (
	"fmt"
	"net/http"
	"testing"
	"time"
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
