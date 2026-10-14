package api

import (
	"encoding/json"
	"testing"
	"time"
)

func TestSuggestionsBuiltAt(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	// fresh for decades: the handler serves it and starts no rebuild
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('suggestions:1', ?, '2090-01-01 00:00:00')`,
		`{"watchlist":[],"builtAt":1760000000}`)
	rec := doReq(mux, "GET", "/api/suggestions", "", c)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var resp SuggestionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.BuiltAt != 1760000000 {
		t.Errorf("builtAt %d, want the blob's own stamp", resp.BuiltAt)
	}
}

func TestBuiltAtFallback(t *testing.T) {
	at := time.Date(2026, 10, 14, 8, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		stamp   int64
		fetched time.Time
		have    bool
		want    int64
	}{
		{"own stamp wins", 42, at, true, 42},
		{"older blob: the cache row's time", 0, at, true, at.Unix()},
		{"aged by staleSuggestions: unknown", 0, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), true, 0},
		{"no blob yet", 0, time.Time{}, false, 0},
	}
	for _, tc := range cases {
		if got := builtAt(tc.stamp, tc.fetched, tc.have); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}
