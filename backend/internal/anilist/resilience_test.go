package anilist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

func stubClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() { endpoint = old })
	c := New(dbtest.Open(t))
	c.HTTP = srv.Client()
	c.limiter = rate.NewLimiter(rate.Inf, 1)
	return c
}

// A bearer AniList no longer accepts (expired, revoked) must not take the
// anonymous lookups down with it: the request is repeated without the token.
func TestRejectedTokenFallsBackToAnonymous(t *testing.T) {
	var n atomic.Int32
	c := stubClient(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"errors":[{"message":"Invalid token","status":400}],"data":null}`))
			return
		}
		w.Write([]byte(`{"data":{"Media":{"id":5,"title":{"romaji":"Kino"}}}}`))
	})
	c.TokenSource = func() string { return "revoked" }

	m, err := c.Media(context.Background(), 5)
	if err != nil || m.ID != 5 {
		t.Fatalf("media with a rejected token: %+v, %v; want the anonymous answer", m, err)
	}
	if n.Load() != 2 {
		t.Fatalf("requests = %d, want the rejected one and one anonymous retry", n.Load())
	}
}
