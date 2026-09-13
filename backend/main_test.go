package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/api"
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

// harden's reader wraps before any handler's own, so a wider cap inside cannot
// widen it back: a chat carrying a couple of pictures used to die on the
// megabyte here and surface as "invalid json". Every other route keeps the
// megabyte.
func TestHardenCapsBodies(t *testing.T) {
	read := func(path string, size int) (int, error) {
		var n int
		var err error
		rec := httptest.NewRecorder()
		harden(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			var b []byte
			b, err = io.ReadAll(r.Body)
			n = len(b)
		})).ServeHTTP(rec, httptest.NewRequest("POST", path, strings.NewReader(strings.Repeat("x", size))))
		return n, err
	}

	if n, err := read("/api/ai/chat", 3<<20); err != nil || n != 3<<20 {
		t.Errorf("assistant body of 3 MiB: read %d bytes, err %v", n, err)
	}
	if n, err := read("/api/ai/chat", api.AIChatBodyLimit+1); err == nil {
		t.Errorf("assistant body past its own limit must be refused, read %d bytes", n)
	}
	if n, err := read("/api/settings", 2<<20); err == nil {
		t.Errorf("every other route stays at a megabyte, read %d bytes", n)
	}
}
