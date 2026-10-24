package anilist

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// A 429 sets one cooldown for every caller: the request that met it returns at
// once (no sleeping through Retry-After in a request path), and the others do
// not hit AniList again until it is over.
func TestRateLimitIsASharedCooldownNotAWait(t *testing.T) {
	var n atomic.Int32
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})

	start := time.Now()
	_, err := c.Media(context.Background(), 1)
	var rl *RateLimitError
	if !errors.As(err, &rl) || rl.RetryAfter <= 0 || rl.RetryAfter > 30*time.Second {
		t.Fatalf("first call: %v, want a RateLimitError with the Retry-After", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("the 429 blocked the caller for %v", time.Since(start))
	}
	// a different lookup meets the cooldown without a request
	if _, err := c.Media(context.Background(), 2); !errors.As(err, &rl) {
		t.Fatalf("second call: %v, want the shared cooldown", err)
	}
	if n.Load() != 1 {
		t.Fatalf("AniList was hit %d times, want 1", n.Load())
	}
}
