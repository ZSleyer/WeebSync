package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type focusRT func(*http.Request) (*http.Response, error)

func (f focusRT) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A banner read that fails for a passing reason (5xx, rate limit, network,
// shutdown) must not pin the centred fallback for a day; only a banner that
// can never be read does.
func TestBannerFocusTransientFailureIsNotPinned(t *testing.T) {
	_, s, _, _, _, _ := setupUsersTest(t)
	old := focusClient.Transport
	defer func() { focusClient.Transport = old }()
	status := 503
	focusClient.Transport = focusRT(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("x")), Header: http.Header{}}, nil
	})
	u := "https://s4.anilist.co/file/anilistcdn/media/anime/banner/9.jpg"

	for _, st := range []int{503, 429} {
		status = st
		_, err := fetchFocus(context.Background(), u)
		s.recordFocus(u, bannerFocus{}, err)
	}
	s.recordFocus(u, bannerFocus{}, context.Canceled)
	if _, ok := s.cacheGet(focusKey(u)+":fail", focusFailAge); ok {
		t.Fatal("transient failure pinned for a day")
	}
	if _, ok := s.cacheGet(focusKey(u)+":retry", focusRetryAge); !ok {
		t.Error("transient failure leaves no short pause: every view would re-fetch")
	}

	status = 404
	_, err := fetchFocus(context.Background(), u)
	if !errors.Is(err, errFocusUnusable) {
		t.Fatalf("404: %v, want unusable", err)
	}
	s.recordFocus(u, bannerFocus{}, err)
	if _, ok := s.cacheGet(focusKey(u)+":fail", focusFailAge); !ok {
		t.Error("a gone banner is not remembered")
	}
}
