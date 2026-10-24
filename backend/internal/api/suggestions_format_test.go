package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// Blobs built before the per-user scoping carry other users' server names and
// folders, and their upgrade plans lack the replace flag. Stale-while-
// revalidate would serve them once more after the deploy; the format bump
// drops them at boot instead.
func TestBlobsFromBeforeTheUserScopeAreNotServed(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('jobs_paused', 'suggestions')`) // no background build
	if err := db.SetSetting(s.DB, "sugg_fmt", "libscope-v10"); err != nil {
		t.Fatal(err)
	}
	old := SuggestionsResponse{Upgrades: []UpgradeSuggestion{{Key: "unit:a:1",
		To: UpgradeVariant{ServerID: 2, ServerName: "Anime-NAS", Folder: "/privat/Show"}}}}
	b, _ := json.Marshal(old)
	s.cacheSet("suggestions:1", string(b))

	s.ClearStaleSuggestionCache()

	mux := http.NewServeMux()
	s.Register(mux)
	c := cookieForUser(t, s.DB, 1)
	for _, path := range []string{"/api/upgrades", "/api/suggestions"} {
		rec := doReq(mux, "GET", path, "", c)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body)
		}
		if body := rec.Body.String(); strings.Contains(body, "Anime-NAS") || strings.Contains(body, "/privat/") {
			t.Errorf("%s served a blob from before the fix: %s", path, body)
		}
	}
}
