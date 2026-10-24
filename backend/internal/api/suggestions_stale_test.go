package api

import (
	"testing"
	"time"
)

// A build reads its inputs at the start and writes minutes later. When the
// suggestions are invalidated in between - a duplicate trashed, the upgrade
// axes reordered - the rebuild asked for then is dropped (one build per user
// at a time), so the running build's result must not count as fresh: it was
// made from what the invalidation said is out of date.
func TestSuggestionsInvalidatedDuringABuildStayStale(t *testing.T) {
	s, _ := sizeTestServer(t)
	fetchedAt := func() string {
		t.Helper()
		var at string
		if err := s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}

	// invalidated while the build ran: stored, but aged for the next read
	start := time.Now().Add(-time.Minute)
	s.staleSuggestions()
	s.storeSuggestions(1, start, SuggestionsResponse{BuiltAt: 1})
	if at := fetchedAt(); at != suggestStaleAt {
		t.Errorf("blob invalidated mid-build stored as fresh (%s)", at)
	}

	// invalidated before the build started: the build saw it, the blob is fresh
	s.DB.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', '-1 hour') WHERE key = ?`, suggestAgedKey)
	s.storeSuggestions(1, time.Now(), SuggestionsResponse{BuiltAt: 2})
	if at := fetchedAt(); at == suggestStaleAt {
		t.Error("a build that started after the invalidation was stored stale")
	}
}
