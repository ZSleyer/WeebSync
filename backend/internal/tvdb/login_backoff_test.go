package tvdb

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A rejected login (wrong key) must not be repeated for every request: it
// burns the instance's login quota. A changed key is tried right away.
func TestLoginRejectionIsRemembered(t *testing.T) {
	var logins atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		logins.Add(1)
		http.Error(w, "bad key", http.StatusUnauthorized)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	t.Setenv("TVDB_BASE_URL", srv.URL)
	t.Setenv("TVDB_API_KEY", "wrong-key")
	c := New(dbtest.Open(t))
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := c.Search(ctx, "conan"); err == nil {
			t.Fatal("want a login error")
		}
	}
	if n := logins.Load(); n != 1 {
		t.Fatalf("%d logins for 3 requests with a rejected key, want 1", n)
	}

	t.Setenv("TVDB_API_KEY", "other-key")
	if _, err := c.Search(ctx, "conan"); err == nil {
		t.Fatal("want a login error")
	}
	if n := logins.Load(); n != 2 {
		t.Fatalf("%d logins after a key change, want 2", n)
	}
}
