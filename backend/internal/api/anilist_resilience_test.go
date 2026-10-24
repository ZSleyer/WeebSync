package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// statusTripper answers every AniList request with a fixed status and body
// and counts them; nothing leaves the test.
type statusTripper struct {
	n      atomic.Int32
	status int
	header map[string]string
	body   string
}

func (s *statusTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	s.n.Add(1)
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Type", "application/json")
	for k, v := range s.header {
		rec.Header().Set(k, v)
	}
	rec.WriteHeader(s.status)
	rec.WriteString(s.body)
	res := rec.Result()
	res.Request = r
	return res, nil
}

func anilistWith(t *testing.T, tr *statusTripper) (*http.ServeMux, *http.Cookie) {
	t.Helper()
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	s.Anilist.HTTP = &http.Client{Transport: tr}
	s.Anilist.WithoutRateLimit()
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	return mux, cookieForUser(t, d, 1)
}

// A rate-limited AniList is a 503 with the wait, answered at once - not a 502
// after a minute's sleep in the handler, and not another upstream request.
func TestAnilistRateLimitAnswersFast503(t *testing.T) {
	tr := &statusTripper{status: http.StatusTooManyRequests, header: map[string]string{"Retry-After": "30"}}
	mux, c := anilistWith(t, tr)

	rec := doReq(mux, "GET", "/api/anilist/media/5", "", c)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("media while limited: %d, Retry-After %q; want 503 with a wait", rec.Code, rec.Header().Get("Retry-After"))
	}
	rec = doReq(mux, "GET", "/api/anilist/search?q=naruto", "", c)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("search while limited: %d, want 503", rec.Code)
	}
	if tr.n.Load() != 1 {
		t.Fatalf("AniList was hit %d times, want the one that met the limit", tr.n.Load())
	}
	if !strings.Contains(rec.Body.String(), "rate limited") {
		t.Errorf("body: %s", rec.Body)
	}
}
