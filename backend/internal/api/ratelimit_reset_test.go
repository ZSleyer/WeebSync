package api

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// An address pasted with stray whitespace unblocks the same bucket as the
// bare one.
func TestRateLimitResetTrimsAddress(t *testing.T) {
	s := &Server{authLimiter: newIPLimiter(1, 1, nil), accountLimiter: newIPLimiter(1, 1, nil)}
	for _, ip := range []string{"203.0.113.9", "2001:db8:1:2::5"} {
		for _, l := range []*ipLimiter{s.authLimiter, s.accountLimiter} {
			l.take(limitKey(ip))
			l.take(accountKey(ip))
		}
		body := `{"ip":" ` + ip + ` "}`
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.handleRateLimitReset(rec, req)
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		if ok, _ := s.authLimiter.take(limitKey(ip)); !ok {
			t.Errorf("%s: auth bucket still blocked after a padded reset", ip)
		}
		if ok, _ := s.accountLimiter.take(accountKey(ip)); !ok {
			t.Errorf("%s: account bucket still blocked after a padded reset", ip)
		}
	}
}
