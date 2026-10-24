package anilist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestExchangeCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		w.Write([]byte(`{"access_token":"tok123","token_type":"Bearer","expires_in":31536000}`))
	}))
	defer srv.Close()
	old := oauthTokenURL
	oauthTokenURL = srv.URL
	t.Cleanup(func() { oauthTokenURL = old })

	d := dbtest.Open(t)
	c := New(d)
	tok, exp, err := c.ExchangeCode(context.Background(), "id", "secret", "http://cb", "code")
	if err != nil || tok != "tok123" || exp != 31536000 {
		t.Fatalf("got %q %d %v", tok, exp, err)
	}

	// error response
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad", http.StatusBadRequest)
	}))
	defer srv2.Close()
	oauthTokenURL = srv2.URL
	if _, _, err := c.ExchangeCode(context.Background(), "id", "secret", "http://cb", "bad"); err == nil {
		t.Error("expected error")
	}
}

// a write-through must not empty the "without fetching" readers: the list is
// aged so the next UserList refetches, but CachedUserList keeps answering.
func TestInvalidateUserListKeepsStaleList(t *testing.T) {
	d := dbtest.Open(t)
	c := New(d)
	c.WithoutRateLimit()
	c.store("alist2:7", `[{"status":"CURRENT","progress":3,"media":{"id":42}}]`)
	c.InvalidateUserList(7)
	got := c.CachedUserList(7)
	if len(got) != 1 || got[0].Media.ID != 42 {
		t.Fatalf("cached list after invalidate = %+v, want the stale entry", got)
	}
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"data":{"MediaListCollection":{"lists":[{"entries":[{"status":"CURRENT","progress":4,"media":{"id":42}}]}]}}}`))
	}))
	defer srv.Close()
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() { endpoint = old })
	list, err := c.UserList(context.Background(), "", 7)
	if err != nil || hits != 1 || len(list) != 1 || list[0].Progress != 4 {
		t.Fatalf("UserList after invalidate: hits=%d list=%+v err=%v, want one refetch", hits, list, err)
	}
}
