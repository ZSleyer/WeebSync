package transfer

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestThrottledReaderLimitsRate(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 300*1024) // 300 KiB
	limiter := rate.NewLimiter(100*1024, 100*1024)
	// drain the initial burst so the measurement covers steady state
	limiter.WaitN(context.Background(), 100*1024)

	tr := &throttledReader{r: bytes.NewReader(data), ctx: context.Background(), limiters: []*rate.Limiter{limiter}}
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
	tr := &throttledReader{r: bytes.NewReader(data), ctx: context.Background(), limiters: []*rate.Limiter{nil, newLimiter(0)}}
	start := time.Now()
	io.Copy(io.Discard, tr)
	if time.Since(start) > time.Second {
		t.Error("unlimited reader was throttled")
	}
}
