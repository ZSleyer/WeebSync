package anilist

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
)

// A media id AniList does not know is remembered, so a page or job that keeps
// asking does not spend a limiter slot every time, and it is a not-found.
func TestUnknownMediaIsNegativelyCached(t *testing.T) {
	var n atomic.Int32
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"errors":[{"message":"Not Found.","status":404}],"data":{"Media":null}}`))
	})
	for i := 0; i < 3; i++ {
		if _, err := c.Media(context.Background(), 999999); !errors.Is(err, ErrNotFound) {
			t.Fatalf("call %d: %v, want ErrNotFound", i, err)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("AniList was asked %d times for the same unknown id, want 1", n.Load())
	}
}
