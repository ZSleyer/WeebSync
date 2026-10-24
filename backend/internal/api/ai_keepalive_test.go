package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// closingWriter records writes that arrive after the handler returned: the
// ResponseWriter must not be touched then (net/http reuses its buffers).
type closingWriter struct {
	mu     sync.Mutex
	h      http.Header
	closed bool
	late   int
}

func (w *closingWriter) Header() http.Header { return w.h }
func (w *closingWriter) WriteHeader(int)     {}
func (w *closingWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		w.late++
	}
	return len(b), nil
}
func (w *closingWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		w.late++
	}
}

// The keepalive goroutine of the chat stream must be done writing before the
// handler returns, also when a tick fires right as the answer ends.
func TestAiChatKeepaliveStopsBeforeReturn(t *testing.T) {
	old := aiKeepalive
	aiKeepalive = 100 * time.Microsecond
	defer func() { aiKeepalive = old }()

	var script []fakeReply
	for i := 0; i < 30; i++ {
		script = append(script, fakeReply{text: "Hello there."})
	}
	fp := newFakeProvider(t, script...)
	fp.onRound = func(int) { time.Sleep(2 * time.Millisecond) } // let ticks fire
	mux, _, c := setupAiTest(t, fp)

	late := 0
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest("POST", "/api/ai/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(setupTokenHeader, testSetupToken)
		req.AddCookie(c)
		w := &closingWriter{h: http.Header{}}
		mux.ServeHTTP(w, req)
		w.mu.Lock()
		w.closed = true
		w.mu.Unlock()
		time.Sleep(2 * time.Millisecond)
		w.mu.Lock()
		late += w.late
		w.mu.Unlock()
	}
	if late > 0 {
		t.Fatalf("%d keepalive writes after the handler returned", late)
	}
}
