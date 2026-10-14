package anilist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// AniList answers a title missing from the list with an HTTP 404 that
// carries its GraphQL error: that is no entry, not a failure.
func TestListEntryMissingIsNoEntry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"errors":[{"message":"Not Found.","status":404}],"data":{"MediaList":null}}`))
	}))
	t.Cleanup(srv.Close)
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() { endpoint = old })
	c := New(dbtest.Open(t))
	c.HTTP = srv.Client()
	c.limiter = rate.NewLimiter(rate.Inf, 1)

	e, err := c.ListEntry(context.Background(), "token", 1, 2)
	if err != nil || e != nil {
		t.Fatalf("missing entry: got %v, %v; want nil, nil", e, err)
	}
}

// a server error without a GraphQL body stays an error
func TestQueryAsBareStatusIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() { endpoint = old })
	c := New(dbtest.Open(t))
	c.HTTP = srv.Client()
	c.limiter = rate.NewLimiter(rate.Inf, 1)

	if _, err := c.ListEntry(context.Background(), "token", 1, 2); err == nil {
		t.Fatal("502 without a body: want an error")
	}
}
