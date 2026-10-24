package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSearchEverywhere(t *testing.T) {
	mux, s, adminC, userC, adminID, userID := setupUsersTest(t)
	srv := func(uid int64, name string) int64 {
		res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc)
			VALUES (?, ?, 'sftp', 'example.com', 22, 'u', x'00')`, uid, name)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	mine := srv(userID, "mine")
	theirs := srv(adminID, "theirs")
	idx := func(sid int64, p, name string, dir int) {
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (?, ?, '/', ?, ?)`, sid, p, name, dir)
	}
	idx(mine, "/anime/Frieren S2", "Frieren S2", 1)
	idx(mine, "/anime/Frieren S2/ep1.mkv", "ep1.mkv", 0)
	idx(theirs, "/anime/Frieren", "Frieren", 1)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id) VALUES (0, '/media/frieren/Frieren', 1)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id) VALUES (0, '/media/frieren/Season 01', 1)`)

	search := func(c *http.Cookie, q string) []SearchHit {
		t.Helper()
		rec := doReq(mux, "GET", "/api/search?q="+q, "", c)
		if rec.Code != http.StatusOK {
			t.Fatalf("search %q: %d %s", q, rec.Code, rec.Body)
		}
		var body SearchResponse
		json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Results
	}

	got := search(userC, "frieren")
	// the user's own server and the local folder named Frieren; not the
	// other user's server, not a local folder that only sits below one
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].ServerID != mine || got[0].ServerName != "mine" || !got[0].IsDir {
		t.Errorf("remote hit = %+v", got[0])
	}
	if got[1].ServerID != 0 || got[1].Name != "Frieren" {
		t.Errorf("local hit = %+v", got[1])
	}
	if len(search(userC, "f")) != 0 {
		t.Error("a single character should return nothing")
	}
	if hits := search(adminC, "frieren%20s2"); len(hits) != 0 {
		t.Errorf("admin has no S2 anywhere, got %+v", hits)
	}
}

// SQL narrows on the whole path, the folder's own name decides. The narrowing
// must not cut the candidates first: with more than 500 folders below an
// "anime" root, the one whose name matches sorts behind them and was lost.
func TestSearchLocalFindsNameBehindManyPathMatches(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	for i := 0; i < 600; i++ {
		s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id) VALUES (0, ?, 1)`,
			fmt.Sprintf("/Anime/Show %04d", i))
	}
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id) VALUES (0, '/Misc/Anime Hits', 1)`)

	rec := doReq(mux, "GET", "/api/search?q=anime", "", adminC)
	if rec.Code != http.StatusOK {
		t.Fatalf("search: %d %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "/Misc/Anime Hits") {
		t.Errorf("the folder named Anime Hits is missing: %s", rec.Body)
	}
}
