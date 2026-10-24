package api

import (
	"context"
	"time"
)

// spawn runs fn in the background and counts it, so Shutdown can wait for
// work a handler fires off and does not wait for itself.
func (s *Server) spawn(fn func()) {
	s.bg.Add(1)
	go func() {
		defer s.bg.Add(-1)
		fn()
	}()
}

// Go is spawn for the long-running loops and startup jobs main starts: they
// are counted like handler work, so Shutdown waits for them before the
// database closes. A loop must return once its context is canceled.
func (s *Server) Go(fn func()) { s.spawn(fn) }

// Shutdown cancels the running background jobs and waits until they and the
// goroutines started with spawn have ended, or ctx is done. Work still writing
// to the database when the process (or a test) lets go of it is the one thing
// a clean exit must not leave behind.
func (s *Server) Shutdown(ctx context.Context) {
	for {
		s.matchMu.Lock()
		for _, cancel := range s.matchJobs {
			cancel()
		}
		idle := len(s.matchJobs) == 0
		s.matchMu.Unlock()
		if idle && s.bg.Load() == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Millisecond):
		}
	}
}
