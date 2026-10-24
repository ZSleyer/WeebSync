package pool

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// Waiting out a full server is not a failure of the server: a lease whose wait
// runs out says ErrServerBusy, so the download queue can wait again without
// spending one of its attempts. A caller that gives up (canceled) is not busy.
func TestLeaseWaitTimeoutIsBusy(t *testing.T) {
	s := startTestSFTP(t, 1)
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 1
	held := grab(t, p, cfg, PriHigh)
	defer held.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := p.Lease(ctx, 1, cfg, PriHigh); !errors.Is(err, remote.ErrServerBusy) {
		t.Errorf("lease past its wait: %v, want ErrServerBusy", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	if _, err := p.Lease(ctx, 1, cfg, PriHigh); errors.Is(err, remote.ErrServerBusy) || !errors.Is(err, context.Canceled) {
		t.Errorf("canceled lease: %v, want context.Canceled and not busy", err)
	}
}
