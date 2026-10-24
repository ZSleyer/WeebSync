package api

import (
	"context"
	"encoding/json"
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
	s.storeSuggestions(context.Background(), 1, start, SuggestionsResponse{BuiltAt: 1})
	if at := fetchedAt(); at != suggestStaleAt {
		t.Errorf("blob invalidated mid-build stored as fresh (%s)", at)
	}

	// invalidated before the build started: the build saw it, the blob is fresh
	s.DB.Exec(`UPDATE anilist_cache SET fetched_at = datetime('now', '-1 hour') WHERE key = ?`, suggestAgedKey)
	s.storeSuggestions(context.Background(), 1, time.Now(), SuggestionsResponse{BuiltAt: 2})
	if at := fetchedAt(); at == suggestStaleAt {
		t.Error("a build that started after the invalidation was stored stale")
	}

	// what the callers do: age, then start the rebuild right away - usually
	// within the same second. That build is the answer to the aging, and
	// storing it stale would make the next read pay a second full build.
	s.staleSuggestions()
	s.storeSuggestions(context.Background(), 1, time.Now(), SuggestionsResponse{BuiltAt: 3})
	if at := fetchedAt(); at == suggestStaleAt {
		t.Error("the rebuild started by the aging was stored stale")
	}
}

// staleSuggestions is two statements, and a running build can store between
// them. The mark comes first, so that build is caught either by its own check
// or by the aging after it - never stored fresh.
func TestSuggestionsStoredBetweenMarkAndAgingStayStale(t *testing.T) {
	s, _ := sizeTestServer(t)
	start := time.Now().Add(-time.Minute)
	s.markSuggestionsAged()
	s.storeSuggestions(context.Background(), 1, start, SuggestionsResponse{BuiltAt: 1})
	s.ageSuggestionBlobs()
	var at string
	if err := s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&at); err != nil {
		t.Fatal(err)
	}
	if at != suggestStaleAt {
		t.Errorf("a build stored mid-invalidation stayed fresh (%s)", at)
	}
}

// A build cut short - the time budget ran out, or the job was stopped - has
// empty provider buckets where the calls failed. They must not replace the
// last build's lists for the next half hour; the library buckets, computed
// without the context, are current and do replace them.
func TestCutShortSuggestionBuildKeepsTheProviderLists(t *testing.T) {
	s, _ := sizeTestServer(t)
	read := func() SuggestionsResponse {
		t.Helper()
		var payload string
		if err := s.DB.QueryRow(`SELECT payload FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		var r SuggestionsResponse
		if err := json.Unmarshal([]byte(payload), &r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	cut, cancel := context.WithCancel(context.Background())
	cancel()

	// no blob yet: the partial build is all there is
	s.storeSuggestions(cut, 1, time.Now(), SuggestionsResponse{BuiltAt: 1})
	if got := read(); got.BuiltAt != 1 {
		t.Errorf("first partial build not stored: %+v", got)
	}

	full := SuggestionsResponse{
		Trending:    []SugItem{{RefKey: "t"}},
		Watchlist:   []SugItem{{RefKey: "w"}},
		Recommended: []SugItem{{RefKey: "r"}},
		Incomplete:  []SugItem{{RefKey: "old-inc"}},
		BuiltAt:     2,
	}
	s.storeSuggestions(context.Background(), 1, time.Now(), full)
	s.storeSuggestions(cut, 1, time.Now(), SuggestionsResponse{Incomplete: []SugItem{{RefKey: "new-inc"}}, BuiltAt: 3})
	got := read()
	if len(got.Trending) != 1 || len(got.Watchlist) != 1 || len(got.Recommended) != 1 || got.Recommended[0].RefKey != "r" {
		t.Errorf("cut-short build emptied the provider lists: %+v", got)
	}
	if len(got.Incomplete) != 1 || got.Incomplete[0].RefKey != "new-inc" || got.BuiltAt != 3 {
		t.Errorf("cut-short build lost its own library lists: %+v", got)
	}
}
