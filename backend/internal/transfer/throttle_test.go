package transfer

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestThrottledReaderLimitsRate(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 300*1024) // 300 KiB
	limiter := rate.NewLimiter(100*1024, 100*1024)
	// drain the initial burst so the measurement covers steady state
	limiter.WaitN(context.Background(), 100*1024)

	tr := &throttledReader{r: bytes.NewReader(data), ctx: context.Background(),
		limiters: func() []*rate.Limiter { return []*rate.Limiter{limiter} }}
	start := time.Now()
	n, err := io.Copy(io.Discard, tr)
	if err != nil || n != int64(len(data)) {
		t.Fatalf("copy: n=%d err=%v", n, err)
	}
	elapsed := time.Since(start)
	// 300 KiB at 100 KiB/s ≈ 3s; allow generous slack for CI
	if elapsed < 2*time.Second {
		t.Errorf("read finished too fast for 100KiB/s limit: %v", elapsed)
	}
}

func TestNilLimiterUnlimited(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 1<<20)
	tr := &throttledReader{r: bytes.NewReader(data), ctx: context.Background(),
		limiters: func() []*rate.Limiter { return []*rate.Limiter{nil, newLimiter(0)} }}
	start := time.Now()
	io.Copy(io.Discard, tr)
	if time.Since(start) > time.Second {
		t.Error("unlimited reader was throttled")
	}
}

// A nil→limiter swap mid-transfer must throttle subsequent reads: the reader
// fetches the limiter set per Read instead of capturing it at start.
func TestLimiterSwapMidTransfer(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 300*1024)
	var mu sync.Mutex
	var limiter *rate.Limiter // starts unlimited

	tr := &throttledReader{r: bytes.NewReader(data), ctx: context.Background(),
		limiters: func() []*rate.Limiter {
			mu.Lock()
			defer mu.Unlock()
			return []*rate.Limiter{limiter}
		}}

	// first chunk unlimited, then switch on a 100 KiB/s limit
	buf := make([]byte, 64*1024)
	if _, err := tr.Read(buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	l := rate.NewLimiter(100*1024, 100*1024)
	l.WaitN(context.Background(), 100*1024) // drain burst for steady state
	mu.Lock()
	limiter = l
	mu.Unlock()

	start := time.Now()
	if _, err := io.Copy(io.Discard, tr); err != nil {
		t.Fatalf("copy: %v", err)
	}
	// ~236 KiB remain at 100 KiB/s ≈ 2.3s
	if elapsed := time.Since(start); elapsed < 1500*time.Millisecond {
		t.Errorf("swapped-in limiter ignored: finished in %v", elapsed)
	}
}
