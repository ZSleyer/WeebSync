package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestWaitReason(t *testing.T) {
	cases := []struct {
		retryAt  int64
		filtered int
		waiting  bool
		airingAt int64
		want     string
	}{
		{100, 3, true, 50, "retry_backoff"},
		{0, 3, true, 50, "lang_backlog"},
		{0, 0, true, 50, "until_slot"},
		{0, 0, true, 0, "finished_idle"},
		{0, 0, false, 50, "interval"},
	}
	for _, c := range cases {
		if got := waitReason(c.retryAt, c.filtered, c.waiting, c.airingAt); got != c.want {
			t.Errorf("waitReason(%+v) = %s, want %s", c, got, c.want)
		}
	}
}

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

// TestWatchExplainLastSteps covers the language and version steps of the
// newest file: name tags against the filter, the cached probe where the name
// says nothing, and the older copy an upgrade moved into the trash.
func TestWatchExplainLastSteps(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, DownloadRoot: t.TempDir()}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'example.com', 22, 'u', X'00', '/')`)
	c := cookieForUser(t, d, 1)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, want_dub) VALUES (1, 1, '/x/Show', '/lib', 'Ger')`)

	explain := func() watchExplainResponse {
		t.Helper()
		rec := doReq(mux, "GET", "/api/watches/1/explain", "", c)
		if rec.Code != http.StatusOK {
			t.Fatalf("explain: got %d: %s", rec.Code, rec.Body)
		}
		var out watchExplainResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out.Last == nil {
			t.Fatalf("no last file: %s", rec.Body)
		}
		return out
	}

	// tagged name, no upgrade: languages from the name, the filter it passed,
	// nothing replaced
	d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, updated_at)
		VALUES (1, 1, '/x/Show/Show - 02 [GerJapDub][GerSub].mkv', '/lib/Show/Show - S01E02.mkv', 1, 'done', '2026-10-01 10:00:00')`)
	got := explain().Last
	if got.Lang == nil || got.Lang.From != "name" || strings.Join(got.Lang.Dub, ",") != "Ger,Jap" ||
		strings.Join(got.Lang.Sub, ",") != "Ger" || got.Lang.WantDub != "Ger" {
		t.Errorf("tagged lang = %+v", got.Lang)
	}
	if got.Replaced != "" {
		t.Errorf("replaced without an upgrade: %q", got.Replaced)
	}

	// untagged name: only a cached probe can answer, and without one the step
	// shows the filter alone
	d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, updated_at, replace_old)
		VALUES (1, 1, '/x/Show/Show - 03 v2.mkv', '/lib/Show/Show - S01E03.mkv', 1, 'done', '2026-10-02 10:00:00', 1)`)
	got = explain().Last
	if got.Lang == nil || got.Lang.From != "" || got.Lang.Dub != nil || got.Lang.WantDub != "Ger" {
		t.Errorf("untagged, unprobed lang = %+v", got.Lang)
	}
	d.Exec(`INSERT INTO anilist_cache (key, payload) VALUES (?, '{"Dub":["ger","jpn"],"Sub":["und"]}')`,
		langProbeKey(1, "/x/Show/Show - 03 v2.mkv"))
	got = explain().Last
	if got.Lang == nil || got.Lang.From != "probe" || strings.Join(got.Lang.Dub, ",") != "Ger,Jap" || got.Lang.Sub != nil {
		t.Errorf("probed lang = %+v", got.Lang)
	}

	// the upgrade's trash: the same episode trashed at the finish wins over
	// another episode, a sidecar and a copy trashed days apart
	at := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC).Unix()
	trash := "/lib/Show/" + trashDir + "/"
	d.Exec(`INSERT INTO trash_files (path, trashed_at) VALUES (?, ?), (?, ?), (?, ?), (?, ?)`,
		trash+"Show - S01E03.mkv", at+2,
		trash+"Show - S01E04.mkv", at+1,
		trash+"Show - S01E03.ass", at+2,
		trash+"Show - S01E03 [old].mkv", at-3*86400)
	if got := explain().Last.Replaced; got != "Show - S01E03.mkv" {
		t.Errorf("replaced = %q, want the trashed S01E03", got)
	}

	// a plain watch download replaced nothing, whatever the trash holds
	d.Exec(`UPDATE downloads SET replace_old = 0`)
	if got := explain().Last.Replaced; got != "" {
		t.Errorf("replaced without replace_old: %q", got)
	}
}
