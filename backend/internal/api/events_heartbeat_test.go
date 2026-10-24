package api

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// With no download running the event stream used to stay silent, and a reverse
// proxy cuts a response that sends nothing for its read timeout (often 60 s):
// the page reconnected and missed what happened meanwhile. The stream sends a
// comment line at a steady interval, and asks nginx-style proxies not to buffer
// it.
func TestEventStreamSendsHeartbeat(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	old := sseHeartbeat
	sseHeartbeat = 20 * time.Millisecond
	t.Cleanup(func() { sseHeartbeat = old })

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	req.Header.Set(setupTokenHeader, testSetupToken)
	req.AddCookie(adminC)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req) // returns when ctx ends

	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering %q, want no", got)
	}
	if n := strings.Count(rec.Body.String(), ": ping\n\n"); n < 2 {
		t.Errorf("%d heartbeats in 200ms at a 20ms interval; body %q", n, rec.Body.String())
	}
}
