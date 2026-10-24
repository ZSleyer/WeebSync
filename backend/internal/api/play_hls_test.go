package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A segment request that has to dial a busy remote must not hold its session
// while it waits: the status poll, the eviction scan (which runs under the
// lock of all sessions) and the reaper all read the session meanwhile. The
// wait itself ends with the request and is bounded.
func TestHLSSegmentDialOutsideSessionLock(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := make(chan struct{})
	defer close(release)
	defer func(f func(*Server, context.Context, playSource) (*ffInput, error)) { hlsInput = f }(hlsInput)
	hlsInput = func(_ *Server, ctx context.Context, _ playSource) (*ffInput, error) {
		entered <- ctx
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release: // only so the old code does not leak the goroutine
			return nil, errors.New("released")
		}
	}

	src := playSource{userID: 1, serverID: 2, path: "/a/x.mkv"}
	sess := &hlsSession{key: hlsKey{src: src}, dir: t.TempDir()}
	h := &hlsSessions{all: map[hlsKey]*hlsSession{sess.key: sess}}
	reqCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := sess.segment(reqCtx, &Server{}, 0)
		done <- err
	}()

	var dialCtx context.Context
	select {
	case dialCtx = <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the run was never started")
	}
	if _, ok := dialCtx.Deadline(); !ok {
		t.Error("the dial has no deadline")
	}

	// the session answers while the dial waits
	answered := make(chan struct{})
	go func() {
		sess.lastUsed()
		st := PlayStatus{Done: -1, Left: -1, Speed: -1}
		h.progressOf(src, &st)
		close(answered)
	}()
	select {
	case <-answered:
	case <-time.After(2 * time.Second):
		t.Fatal("the session is locked over the dial")
	}

	// the request goes away: so does its dial
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("segment: %v, want the request's cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the dial outlived its request")
	}
}
