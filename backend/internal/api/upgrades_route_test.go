package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// GET /api/upgrades never builds on the request: the build walks the mounts
// and costs seconds to minutes, and every call paid it again. It serves the
// upgrades of the user's cached suggestions blob, with the user's dismissals
// applied, and leaves the building to the background.
func TestUpgradesRouteServesTheCachedBlob(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('jobs_paused', 'suggestions')`) // no build in the test
	// the catalog holds an upgrade the request path must not compute
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, probed)
		VALUES (0, '/lib/Show/Season 01', 720, 'Jap', 'tvdb:11', 1, 1)`)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, probed)
		VALUES (1, '/seed/Show', 1080, 'Jap', 'tvdb:11', 1, 1)`)
	mux := http.NewServeMux()
	s.Register(mux)
	c := cookieForUser(t, s.DB, 1)
	get := func() []UpgradeSuggestion {
		t.Helper()
		rec := doReq(mux, "GET", "/api/upgrades", "", c)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		var out []UpgradeSuggestion
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out == nil {
			t.Fatalf("body %s: %v", rec.Body, err)
		}
		return out
	}

	if got := get(); len(got) != 0 {
		t.Errorf("no blob yet: the route computed %d upgrades on the request", len(got))
	}

	b, _ := json.Marshal(SuggestionsResponse{Upgrades: []UpgradeSuggestion{{Key: "unit:a:1"}, {Key: "unit:b:1"}}})
	s.cacheSet("suggestions:1", string(b))
	s.DB.Exec(`INSERT INTO suggestion_dismissals (user_id, ref_key, kind) VALUES (1, 'unit:b:1', 'upgrade')`)
	if got := get(); len(got) != 1 || got[0].Key != "unit:a:1" {
		t.Errorf("want the blob's upgrades without the dismissed one, got %+v", got)
	}
}
