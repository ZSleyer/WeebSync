package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// The catalog holds the copies of every user's servers in one table; only the
// local library (server 0) belongs to everyone. User 2 owns "Anime-NAS" with
// a better copy and a missing season of a show the library holds: user 1 must
// see none of it - no card, no server name, no folder - while user 2 does.
func TestUnitSuggestionsStayOnTheOwnersServers(t *testing.T) {
	s, root := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO users (id, email, upgrade_dims) VALUES (2,'b@e.test','res,sub,dub,soft')`)
	s.DB.Exec(`INSERT INTO servers (id, user_id, name, protocol, host, port, username, secret_enc)
		VALUES (2,2,'Anime-NAS','sftp','h',22,'u',x'00')`)

	local := filepath.Join(root, "Serien", "Show", "Season 01")
	writeFiles(t, local, map[string]int64{"Show - S01E01.mkv": 10})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, probed)
		VALUES (0, ?, 720, 'Jap', 'tvdb:7', 1, 1)`, local)
	// the better copy of season 1, a missing season 2 and more episodes
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, probed)
		VALUES (2, '/privat/Show S1', 1080, 'Jap', 'tvdb:7', 1, 1)`)
	addRemoteFiles(t, s, 2, "/privat/Show S1", map[string]int64{"Show - 01.mkv": 20, "Show - 02.mkv": 30})
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, probed)
		VALUES (2, '/privat/Show S2', 1080, 'Jap', 'tvdb:7', 2, 1)`)
	addRemoteFiles(t, s, 2, "/privat/Show S2", map[string]int64{"Show - 01.mkv": 40})
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (2, '/privat/Show S2', 7, 1, 'tvdb')`)

	leaks := func(v any) bool {
		b, _ := json.Marshal(v)
		return strings.Contains(string(b), "Anime-NAS") || strings.Contains(string(b), "/privat/")
	}
	collect := func(userID int64) (ups []UpgradeSuggestion, inc []SugItem) {
		acc := newAcc()
		s.addMissingUnits(acc, userID)
		s.addMissingEpisodes(acc, userID)
		return s.buildUpgrades(userID), acc.list(nil)
	}

	ups, inc := collect(1)
	if len(ups) != 0 || leaks(ups) {
		t.Errorf("user 1 got upgrades from another user's server: %+v", ups)
	}
	if len(inc) != 0 || leaks(inc) {
		t.Errorf("user 1 got incomplete items from another user's server: %+v", inc)
	}

	// the owner does see them, so the checks above are not vacuous
	ups, inc = collect(2)
	if len(ups) != 1 || !leaks(ups) {
		t.Errorf("owner: want the upgrade from Anime-NAS, got %+v", ups)
	}
	kinds := map[string]bool{}
	for _, it := range inc {
		kinds[it.Kind] = true
	}
	if len(inc) != 2 || !kinds["episodes"] || !leaks(inc) {
		t.Errorf("owner: want the missing season and episodes, got %+v", inc)
	}

	// and each user's cached blob, which /api/upgrades and /api/suggestions
	// serve, is built from that user's view and read back under their own key
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('jobs_paused', 'suggestions')`) // no background build
	for _, id := range []int64{1, 2} {
		ups, inc := collect(id)
		b, _ := json.Marshal(SuggestionsResponse{Upgrades: ups, Incomplete: inc})
		s.cacheSet(fmt.Sprintf("suggestions:%d", id), string(b))
	}
	mux := http.NewServeMux()
	s.Register(mux)
	for _, path := range []string{"/api/upgrades", "/api/suggestions"} {
		for id, want := range map[int64]bool{1: false, 2: true} {
			rec := doReq(mux, "GET", path, "", cookieForUser(t, s.DB, id))
			if rec.Code != http.StatusOK {
				t.Fatalf("%s as %d: %d %s", path, id, rec.Code, rec.Body)
			}
			b := rec.Body.String()
			if got := strings.Contains(b, "Anime-NAS") || strings.Contains(b, "/privat/"); got != want {
				t.Errorf("%s as user %d: shows Anime-NAS = %v, want %v: %s", path, id, got, want, b)
			}
		}
	}
}
