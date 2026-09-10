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

// The assistant dictates through the browser's own speech recognition, which
// needs the microphone. A blanket microphone=() refuses the recognizer before
// it hears anything, and the dictation then sits on "listening" forever - the
// symptom names no cause, so the header carries the check.
func TestHardenLetsTheMicrophoneThrough(t *testing.T) {
	rec := httptest.NewRecorder()
	harden(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))

	pp := rec.Header().Get("Permissions-Policy")
	if !strings.Contains(pp, "microphone=(self)") {
		t.Errorf("dictation needs the microphone on our own origin: %q", pp)
	}
	// and nothing else was opened up along the way
	for _, want := range []string{"camera=()", "geolocation=()"} {
		if !strings.Contains(pp, want) {
			t.Errorf("Permissions-Policy lost %q: %q", want, pp)
		}
	}
}
