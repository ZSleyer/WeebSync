package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The explanation replays the match from the search cache: the season folder
// gives the search its context, the sequel entry wins on its season marker,
// and the stored match and the scope mark come along.
func TestExplainFolder(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d)}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	const dir = "/x/2026-4 Fall"
	name := "Kusuriya no Hitorigoto 3rd Season [GerJapDub,GerEngSub]"
	folder := dir + "/" + name
	d.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, ?, 'anime')`, dir)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (1, ?, 300, 0, 'anilist')`, folder)
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (1, ?, 300, 0, 'anilist')`, dir+"/Kusuriya no Hitorigoto 3rd Season [JapDub]")

	media := func(id int, romaji, english string, year int) anilist.Media {
		var m anilist.Media
		m.ID, m.Title.Romaji, m.Title.English, m.Format, m.SeasonYear = id, romaji, english, "TV", year
		return m
	}
	list := []anilist.Media{
		media(100, "Kusuriya no Hitorigoto", "The Apothecary Diaries", 2023),
		media(300, "Kusuriya no Hitorigoto 3rd Season", "The Apothecary Diaries Season 3", 2026),
	}
	payload, _ := json.Marshal(list)
	key := "search:" + strings.ToLower(GuessTitle(name)) + "|FALL2026"
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, ?)`, key, string(payload))

	out, err := s.explainFolder(context.Background(), 1, folder)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Scored || out.Pick != 300 || !out.Confident {
		t.Fatalf("scored=%v pick=%d confident=%v, want the 3rd season confidently", out.Scored, out.Pick, out.Confident)
	}
	if len(out.Tried) != 1 || out.Tried[0].Stage != "search" || out.Tried[0].Hits != 2 || out.Tried[0].Season != "FALL" {
		t.Errorf("tried = %+v, want one season-filtered search with 2 hits", out.Tried)
	}
	if len(out.Candidates) != 2 || out.Candidates[0].ID != 300 || out.Candidates[0].Score <= out.Candidates[1].Score {
		t.Errorf("candidates = %+v, want the 3rd season first", out.Candidates)
	}
	if out.Parse.Season != 3 {
		t.Errorf("parse season = %d, want 3", out.Parse.Season)
	}
	if out.Scope.Origin != "marked" || out.Scope.Kind != "anime" {
		t.Errorf("scope = %+v, want marked anime", out.Scope)
	}
	if out.Chosen == nil || out.Chosen.MediaID != 300 || out.Chosen.Manual {
		t.Errorf("chosen = %+v, want automatic 300", out.Chosen)
	}
	if len(out.Bundle) != 1 || !strings.HasSuffix(out.Bundle[0], "[JapDub]") {
		t.Errorf("bundle = %v, want the JapDub sibling", out.Bundle)
	}
}
