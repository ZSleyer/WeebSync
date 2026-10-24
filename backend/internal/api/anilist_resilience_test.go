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

// A negative media id would be stored as a manual match that counts as
// matched yet can never resolve; 0 stays the way to mark "no match".
func TestCatalogMatchRejectsNegativeMediaID(t *testing.T) {
	mux, c := anilistWith(t, &statusTripper{status: http.StatusOK, body: `{"data":{}}`})
	rec := doReq(mux, "PUT", "/api/servers/0/catalog/match", `{"folder":"/x","mediaId":-1}`, c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mediaId -1: %d %s, want 400", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/servers/0/catalog/match", `{"folder":"/x","mediaId":0}`, c); rec.Code != http.StatusOK {
		t.Fatalf("mediaId 0 (no match): %d %s, want 200", rec.Code, rec.Body)
	}
}

// An id that cannot exist never reaches AniList (400), and one AniList does
// not know is a 404 that is remembered rather than a 502 asked again each time.
func TestAnilistMediaUnknownIDs(t *testing.T) {
	tr := &statusTripper{status: http.StatusNotFound,
		body: `{"errors":[{"message":"Not Found.","status":404}],"data":{"Media":null}}`}
	mux, c := anilistWith(t, tr)

	for _, id := range []string{"0", "-4", "abc"} {
		if rec := doReq(mux, "GET", "/api/anilist/media/"+id, "", c); rec.Code != http.StatusBadRequest {
			t.Errorf("media/%s: %d, want 400", id, rec.Code)
		}
	}
	if tr.n.Load() != 0 {
		t.Fatalf("invalid ids reached AniList %d times", tr.n.Load())
	}
	for i := 0; i < 3; i++ {
		if rec := doReq(mux, "GET", "/api/anilist/media/987654", "", c); rec.Code != http.StatusNotFound {
			t.Fatalf("unknown id, call %d: %d %s, want 404", i, rec.Code, rec.Body)
		}
	}
	if tr.n.Load() != 1 {
		t.Fatalf("AniList was asked %d times for one unknown id, want 1", tr.n.Load())
	}
}
