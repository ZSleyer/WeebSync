package api

import (
	"encoding/json"
	"testing"
)

func TestPatchSuggestionProgress(t *testing.T) {
	s, _ := sizeTestServer(t)
	blob := `{"watchlist":[{"refKey":"series:1","media":{"id":7},"status":"CURRENT","progress":3},` +
		`{"refKey":"series:2","media":{"id":8},"status":"CURRENT","progress":1}],` +
		`"trending":[{"refKey":"series:1","media":{"id":7}}]}`
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('suggestions:1', ?, '2030-01-01 00:00:00')`, blob)

	s.patchSuggestionProgress(1, 7, 4)

	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = 'suggestions:1'`).Scan(&payload, &fetched)
	var resp SuggestionsResponse
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		t.Fatal(err)
	}
	if got := resp.Watchlist[0].Progress; got != 4 {
		t.Errorf("patched entry: progress %d, want 4", got)
	}
	if got := resp.Watchlist[1].Progress; got != 1 {
		t.Errorf("other entry: progress %d, want 1", got)
	}
	// a title that is not on the list gets no count
	if got := resp.Trending[0].Progress; got != 0 {
		t.Errorf("trending entry: progress %d, want 0", got)
	}
	if fetched != "2030-01-01 00:00:00" {
		t.Errorf("fetched_at moved to %s", fetched)
	}
	// no blob yet: nothing to patch, nothing created
	s.patchSuggestionProgress(2, 7, 4)
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE key = 'suggestions:2'`).Scan(&n)
	if n != 0 {
		t.Errorf("blob created for a user without one")
	}
}
