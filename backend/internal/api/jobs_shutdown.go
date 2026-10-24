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

// lifetimeCtx is the context of the server's own background work, canceled
// when Shutdown begins. Built on first use, so every Server literal has one.
func (s *Server) lifetimeCtx() context.Context {
	s.lifeOnce.Do(func() { s.life, s.lifeCancel = context.WithCancel(context.Background()) })
	return s.life
}

// stopping reports whether Shutdown has begun: the one-off startup passes
// check it per item and end early, leaving their stamp unset for next start.
func (s *Server) stopping() bool { return s.lifetimeCtx().Err() != nil }

// Shutdown cancels the running background jobs and waits until they and the
// goroutines started with spawn have ended, or ctx is done. Work still writing
// to the database when the process (or a test) lets go of it is the one thing
// a clean exit must not leave behind. The download digests still collecting
// in memory are sent last, once the jobs that could add to them are done,
// within what is left of ctx, and their mails (sent through spawn) are
// waited for like any other background work.
func (s *Server) Shutdown(ctx context.Context) {
	s.lifetimeCtx()
	s.lifeCancel()
	s.waitIdle(ctx)
	s.flushDigests(ctx)
	s.waitIdle(ctx)
}

// waitIdle cancels the running match jobs and waits until they and the
// spawned goroutines have ended, or ctx is done.
func (s *Server) waitIdle(ctx context.Context) {
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
