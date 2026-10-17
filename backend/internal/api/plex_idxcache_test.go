package api

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// within fails the test when f does not return in d.
func returnsWithin(t *testing.T, d time.Duration, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { f(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s waited on the media server", what)
	}
}

// A dead media server used to hang the local catalog listing: every unmatched
// folder rebuilt the index from all libraries itself. The request paths now
// answer at once, one background build is shared, and its failure is
// remembered.
func TestPlexIndexRequestPathsNeverWaitOnPlex(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		<-release
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer srv.Close()
	var once sync.Once
	free := func() { once.Do(func() { close(release) }) }
	defer free()

	d := dbtest.Open(t)
	s := &Server{DB: d}
	db.SetSetting(d, "plex_url", srv.URL)
	db.SetSetting(d, "plex_token", "tok")

	returnsWithin(t, 2*time.Second, "request paths", func() {
		for range 20 { // twenty unmatched folders of one listing
			if _, ok := s.matchLocalByPlexID("/anime/Some Show (2020)", "tvdb"); ok {
				t.Error("an empty index matched")
			}
		}
		s.plexIDs()
		s.plexRatingKeyResolve("tvdb:1")
		s.plexWebLink("Some Show")
	})

	// the one build is in flight; a background caller joins it
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() { s.plexGuidIndex() })
	}
	time.Sleep(50 * time.Millisecond)
	free()
	wg.Wait()
	eventually(t, func() bool { return s.plexGuids.idle() && s.plexTitles.idle() })

	if n := hits.Load(); n != 2 { // sections for the guid and for the title index
		t.Errorf("%d requests reached the server, want one build per index", n)
	}
	// the failure is remembered: neither kind of caller asks again
	returnsWithin(t, time.Second, "retry", func() {
		for range 5 {
			s.plexGuidIndex()
			s.plexGuidIndexNoWait()
			s.plexTitleIndexNoWait()
		}
	})
	if n := hits.Load(); n != 2 {
		t.Errorf("a failed build was retried at once: %d requests", n)
	}
}

func (x *plexIndexCache[T]) idle() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.building == nil
}

func eventually(t *testing.T, ok func() bool) {
	t.Helper()
	for range 200 {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

// Callers that arrive while a build runs share it, and a request path is
// served the last copy meanwhile.
func TestPlexIndexCacheSharesOneBuildAndServesTheLastCopy(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d}
	var x plexIndexCache[map[string]string]
	const key = "plex:test"

	// an expired copy from before a restart answers the request path at once
	s.cacheSet(key, `{"old":"1"}`)
	d.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', '-3 hours') WHERE key = ?`, key)

	var builds atomic.Int32
	gate := make(chan struct{})
	build := func() (map[string]string, bool) {
		builds.Add(1)
		<-gate
		return map[string]string{"new": "2"}, true
	}
	var got map[string]string
	returnsWithin(t, time.Second, "no-wait", func() { got = x.get(s, key, false, build) })
	if got["old"] != "1" {
		t.Errorf("served %v, want the expired copy", got)
	}

	res := make(chan map[string]string, 4)
	for range 4 {
		go func() { res <- x.get(s, key, true, build) }()
	}
	time.Sleep(50 * time.Millisecond)
	close(gate)
	for range 4 {
		if r := <-res; r["new"] != "2" {
			t.Errorf("a waiter got %v, want the new index", r)
		}
	}
	if n := builds.Load(); n != 1 {
		t.Errorf("%d builds, want 1", n)
	}
	if _, ok := s.cacheGet(key, time.Hour); !ok {
		t.Error("the new index was not stored")
	}
}

// A failed build is not retried for plexIndexRetry, and the last copy stays.
func TestPlexIndexCacheRemembersAFailure(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d}
	var x plexIndexCache[map[string]string]
	var builds atomic.Int32
	build := func() (map[string]string, bool) { builds.Add(1); return map[string]string{}, false }
	for range 3 {
		if r := x.get(s, "plex:test", true, build); len(r) != 0 {
			t.Errorf("got %v from a failed build", r)
		}
	}
	if n := builds.Load(); n != 1 {
		t.Errorf("%d builds inside the retry window, want 1", n)
	}
	x.mu.Lock()
	x.failedAt = time.Now().Add(-2 * plexIndexRetry)
	x.mu.Unlock()
	x.get(s, "plex:test", true, build)
	if n := builds.Load(); n != 2 {
		t.Errorf("%d builds after the window, want 2", n)
	}
}
