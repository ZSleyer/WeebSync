package api

import (
	"encoding/json"
	"sync"
	"time"
)

const (
	plexIndexTTL = time.Hour
	// a build that failed is not tried again for this long, so a dead server
	// costs one timeout per half minute, not one per caller
	plexIndexRetry = 30 * time.Second
	// any cached copy beats none when a newer one cannot be had
	plexIndexStale = 100 * 365 * 24 * time.Hour
)

// plexIndexCache keeps one index of the media server's libraries: a fresh copy
// comes from the cache table, a missing one is built once for every caller
// that asks meanwhile, a failed build is remembered for plexIndexRetry, and the
// last good copy is served while a newer one is built. Request paths ask with
// wait=false and never block on the server; they get the last copy (or an
// empty index) and the build runs in the background. The zero value is ready.
type plexIndexCache[T any] struct {
	mu       sync.Mutex
	last     T
	have     bool
	building chan struct{} // non-nil while a build runs, closed when it ends
	failedAt time.Time
}

// get returns the index stored under key. build reports ok=false when the
// server could not be read; the result is then not stored.
func (x *plexIndexCache[T]) get(s *Server, key string, wait bool, build func() (T, bool)) T {
	x.mu.Lock()
	var v T
	if p, ok := s.cacheGet(key, plexIndexTTL); ok && json.Unmarshal([]byte(p), &v) == nil {
		x.last, x.have = v, true
		x.mu.Unlock()
		return v
	}
	if !x.have {
		// after a restart the expired row still beats waiting for the server
		if p, ok := s.cacheGet(key, plexIndexStale); ok {
			var old T
			if json.Unmarshal([]byte(p), &old) == nil {
				x.last, x.have = old, true
			}
		}
	}
	stale := x.last
	if !x.failedAt.IsZero() && time.Since(x.failedAt) < plexIndexRetry {
		x.mu.Unlock()
		return stale
	}
	ch := x.building
	if ch == nil {
		ch = make(chan struct{})
		x.building = ch
		go x.run(s, key, build, ch)
	}
	x.mu.Unlock()
	if !wait {
		return stale
	}
	<-ch
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.last
}

func (x *plexIndexCache[T]) run(s *Server, key string, build func() (T, bool), done chan struct{}) {
	v, ok := build()
	var payload []byte
	if ok {
		payload, _ = json.Marshal(v)
		s.cacheSet(key, string(payload))
	}
	x.mu.Lock()
	if ok {
		x.last, x.have, x.failedAt = v, true, time.Time{}
	} else {
		x.failedAt = time.Now()
	}
	x.building = nil
	x.mu.Unlock()
	close(done)
}

// reset forgets the last copy and any failure, for a server change: the old
// server's keys must not be served for the new one.
func (x *plexIndexCache[T]) reset() {
	x.mu.Lock()
	var zero T
	x.last, x.have, x.failedAt = zero, false, time.Time{}
	x.mu.Unlock()
}
