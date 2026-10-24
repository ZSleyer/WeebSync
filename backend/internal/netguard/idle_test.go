package netguard

import (
	"net/http"
	"testing"
	"time"
)

// Every guarded client is built with its own transport, and callers build one
// per push or login. A zero IdleConnTimeout means "no limit": the keep-alive
// connections and their goroutines would stay until the far side hangs up.
func TestClientsCloseIdleConnections(t *testing.T) {
	for name, c := range map[string]*http.Client{
		"Client":            Client(time.Second),
		"PublicClient":      PublicClient(time.Second),
		"PublicFetchClient": PublicFetchClient(time.Second),
	} {
		tr, ok := c.Transport.(*http.Transport)
		if !ok {
			t.Fatalf("%s: transport %T", name, c.Transport)
		}
		if tr.IdleConnTimeout <= 0 {
			t.Errorf("%s: IdleConnTimeout %v, want a limit", name, tr.IdleConnTimeout)
		}
	}
}
