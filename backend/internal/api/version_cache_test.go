package api

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A failed update check (rate limit, offline) is not "no update": it must not
// sit in the cache for hours. After the short failure hold the next call asks
// upstream again and sees the release.
func TestUpdateCheckDoesNotCacheFailure(t *testing.T) {
	var up atomic.Bool
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			http.Error(w, "rate limited", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v2.0.0","html_url":"https://example.com/r"}`))
	}))
	t.Cleanup(gh.Close)
	prev := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = prev })

	s := testServer(t, &Server{DB: dbtest.Open(t)})
	check := func() versionInfo {
		info := versionInfo{Version: "v1.0.0", Channel: "stable", Repo: "o/r"}
		s.fillUpdate(&info)
		return info
	}
	if info := check(); info.UpdateAvailable || info.Latest != "" {
		t.Fatalf("failed check reported %+v", info)
	}
	up.Store(true)
	// within the hold upstream is not asked again
	if info := check(); info.Latest != "" {
		t.Errorf("inside the failure hold: %+v", info)
	}
	// the failure hold has passed
	if _, err := s.DB.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', '-2 minutes')`); err != nil {
		t.Fatal(err)
	}
	if info := check(); !info.UpdateAvailable || info.Latest != "v2.0.0" {
		t.Errorf("after the failure: %+v, want v2.0.0 available", info)
	}
}
