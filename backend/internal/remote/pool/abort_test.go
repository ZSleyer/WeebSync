package pool

import (
	"context"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// An aborted lease gives its slot back at once and its connection is not
// handed out again: with one connection allowed, the next lease dials anew
// instead of waiting for a Close that a stuck call may never let happen.
func TestAbortedLeaseFreesSlot(t *testing.T) {
	s := startTestSFTP(t, 1)
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 1
	held := grab(t, p, cfg, PriHigh)
	a, ok := held.(remote.Aborter)
	if !ok {
		t.Fatal("a pooled lease cannot be aborted")
	}
	a.Abort()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	next, err := p.Lease(ctx, 1, cfg, PriHigh)
	if err != nil {
		t.Fatalf("lease after an abort: %v", err)
	}
	defer next.Close()
	if _, err := next.List(s.dir); err != nil {
		t.Errorf("list on the fresh lease: %v", err)
	}
	held.Close() // late close of the aborted lease must not free a second slot
}
