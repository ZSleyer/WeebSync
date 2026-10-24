package api

import (
	"context"
	"encoding/json"
	"testing"
)

// Aging the suggestions (a new server, a settings change) dates every blob
// far into the past so the next read rebuilds it. The assistant must keep
// serving the last blob while that rebuild runs, as the Suggestions page
// does, instead of answering as if there were no suggestions at all.
func TestAiSuggestionBlobServesAgedBlobWhileRebuilding(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	b, _ := json.Marshal(SuggestionsResponse{Upgrades: []UpgradeSuggestion{{Key: "unit:x:1", Title: "Frieren"}}})
	s.cacheSet("suggestions:1", string(b))
	s.staleSuggestions()

	// a rebuild is already running: the read must not wait for it
	s.matchMu.Lock()
	if s.matchJobs == nil {
		s.matchJobs = map[string]context.CancelFunc{}
	}
	s.matchJobs["suggestions:1"] = func() {}
	s.matchMu.Unlock()
	t.Cleanup(func() {
		s.matchMu.Lock()
		delete(s.matchJobs, "suggestions:1")
		s.matchMu.Unlock()
	})

	got, building := s.aiSuggestionBlob(context.Background(), 1)
	if !building {
		t.Error("aged blob not reported as rebuilding")
	}
	if len(got.Upgrades) != 1 || got.Upgrades[0].Key != "unit:x:1" {
		t.Fatalf("aged blob not served while rebuilding: %+v", got)
	}
}
