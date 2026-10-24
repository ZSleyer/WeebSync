package api

import (
	"context"
	"testing"
	"time"
)

// The loops and startup jobs main starts run through Go, so Shutdown waits for
// them before the database closes.
func TestShutdownWaitsForGo(t *testing.T) {
	s := &Server{}
	release := make(chan struct{})
	s.Go(func() { <-release })

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	s.Shutdown(ctx)
	if ctx.Err() == nil {
		t.Fatal("Shutdown returned while a Go goroutine was still running")
	}
	close(release)
	done := make(chan struct{})
	go func() { s.Shutdown(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after the goroutine ended")
	}
}
