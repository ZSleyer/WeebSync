package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The trailer iframe in the catalog detail dialog is the only thing the app
// embeds. It has no directive of its own to fall back on, so a CSP without
// frame-src blocks it under default-src - which is how trailers silently
// stopped rendering.
func TestHardenAllowsTheTrailerFrame(t *testing.T) {
	rec := httptest.NewRecorder()
	harden(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-src https://www.youtube-nocookie.com") {
		t.Errorf("trailer origin missing from CSP: %q", csp)
	}
	// the frame exception must not have widened anything else
	for _, want := range []string{"default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lost %q: %q", want, csp)
		}
	}
}
