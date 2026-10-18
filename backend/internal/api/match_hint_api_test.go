package api

import (
	"net/http"
	"testing"
)

func TestHintDismissRoute(t *testing.T) {
	s, _ := hintServer(t)
	mux := http.NewServeMux()
	s.Register(mux)
	c := cookieForUser(t, s.DB, 1)
	f := "/Area/Neo Yokio [EngDub]"
	lookup(t, s, f, false)
	if w := doReq(mux, "POST", "/api/servers/1/catalog/hint/dismiss", `{"folder":"`+f+`"}`, c); w.Code != http.StatusOK {
		t.Fatalf("dismiss: %d %s", w.Code, w.Body)
	}
	if s.hintFor(1, f) != nil {
		t.Error("hint still offered after dismissal")
	}
	if w := doReq(mux, "POST", "/api/servers/1/catalog/hint/dismiss", `{"folder":"/a/../x"}`, c); w.Code != http.StatusBadRequest {
		t.Errorf("bad folder: %d", w.Code)
	}
}

// Taking a hint stores a manual TMDB match in an AniList-scoped folder. The
// automatic match that runs over that folder on a later listing must not
// replace it.
func TestTakenHintSurvivesAutomaticMatch(t *testing.T) {
	s, _ := hintServer(t)
	s.Anilist = fakeSearchAnilist(t, nil, nil)
	f := "/Area/Neo Yokio [EngDub]"
	if err := s.persistMatch(1, f, 11, true, "tmdb:tv"); err != nil {
		t.Fatal(err)
	}
	s.matchBatch([]matchJob{{serverID: 1, folder: f, name: "Neo Yokio [EngDub]"}})
	var id, manual int
	var src string
	if err := s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches WHERE server_id = 1 AND folder = ?`, f).Scan(&id, &manual, &src); err != nil {
		t.Fatal(err)
	}
	if id != 11 || manual != 1 || src != "tmdb:tv" {
		t.Fatalf("the manual match was replaced: %d %d %s", id, manual, src)
	}
}
