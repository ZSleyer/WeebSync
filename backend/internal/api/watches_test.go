package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

func cookieForUser(t *testing.T, d *sql.DB, id int64) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	if err := auth.CreateSession(d, rec, httptest.NewRequest("GET", "/", nil), id); err != nil {
		t.Fatal(err)
	}
	return rec.Result().Cookies()[0]
}

func TestWatchCRUD(t *testing.T) {
	d := dbtest.Open(t)
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{
		DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, t.TempDir()),
	}
	mux := http.NewServeMux()
	s.Register(mux)

	// users + server
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('b@example.com', 0)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookieA := cookieForUser(t, d, 1)
	cookieB := cookieForUser(t, d, 2)

	// create
	rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookieA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d: %s", rec.Code, rec.Body)
	}
	// duplicate
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookieA); rec.Code != http.StatusConflict {
		t.Errorf("duplicate: got %d, want 409", rec.Code)
	}
	// foreign server
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/y","localPath":""}`, cookieB); rec.Code != http.StatusNotFound {
		t.Errorf("foreign server: got %d, want 404", rec.Code)
	}
	// list: global interval echoed (default 30)
	rec = doReq(mux, "GET", "/api/watches", "", cookieA)
	var list []Watch
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].IntervalMin != 30 || list[0].Mode != "template" {
		t.Fatalf("list: %s", rec.Body)
	}
	id := list[0].ID
	// foreign delete
	if rec := doReq(mux, "DELETE", fmt.Sprintf("/api/watches/%d", id), "", cookieB); rec.Code != http.StatusNotFound {
		t.Errorf("foreign delete: got %d, want 404", rec.Code)
	}
	// own update + delete
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"remotePath":"/x/Show","localPath":"anime","mode":"regex","pattern":"\\d+","replacement":"E$0"}`, cookieA); rec.Code != http.StatusOK {
		t.Errorf("update: got %d: %s", rec.Code, rec.Body)
	}
	// Plex playback preference round-trips through update and list
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"remotePath":"/x/Show","localPath":"anime","plexAudioLang":"Jap","plexSubLang":"Ger"}`, cookieA); rec.Code != http.StatusOK {
		t.Errorf("plex streams update: got %d: %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/watches", "", cookieA)
	list = nil
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].PlexAudioLang != "Jap" || list[0].PlexSubLang != "Ger" {
		t.Errorf("plex streams roundtrip: %s", rec.Body)
	}
	// update may move the watch to another remote/local path
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"remotePath":"/x/Show v2","localPath":"anime2"}`, cookieA); rec.Code != http.StatusOK {
		t.Errorf("path update: got %d: %s", rec.Code, rec.Body)
	}
	var gotRemote, gotLocal string
	d.QueryRow(`SELECT remote_path, local_path FROM watches WHERE id = ?`, id).Scan(&gotRemote, &gotLocal)
	if gotRemote != "/x/Show v2" || gotLocal != "anime2" {
		t.Errorf("path update stored %q %q", gotRemote, gotLocal)
	}
	// moving onto another watch's paths conflicts
	doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Other","localPath":"anime"}`, cookieA)
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"remotePath":"/x/Other","localPath":"anime"}`, cookieA); rec.Code != http.StatusConflict {
		t.Errorf("duplicate update: got %d, want 409", rec.Code)
	}
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"remotePath":"/x/Show","mode":"nope"}`, cookieA); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid mode: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "PUT", fmt.Sprintf("/api/watches/%d", id), `{"mode":"regex"}`, cookieA); rec.Code != http.StatusBadRequest {
		t.Errorf("missing remotePath: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "DELETE", fmt.Sprintf("/api/watches/%d", id), "", cookieA); rec.Code != http.StatusOK {
		t.Errorf("delete: got %d", rec.Code)
	}
}

func TestSmartDue(t *testing.T) {
	now := time.Now()
	airing := func(ep int, at time.Time) *anilist.Media {
		m := &anilist.Media{Status: "RELEASING"}
		m.NextAiring = &struct {
			AiringAt int64 `json:"airingAt"`
			Episode  int   `json:"episode"`
		}{AiringAt: at.Unix(), Episode: ep}
		return m
	}
	finished := func(eps int) *anilist.Media { return &anilist.Media{Status: "FINISHED", Episodes: eps} }
	cases := []struct {
		name        string
		intervalDue bool
		media       *anilist.Media
		have        int
		offset      int
		fromEpisode int
		filtered    int
		aired       bool
		want        bool
	}{
		{"interval not reached", false, nil, 0, 0, 0, 0, false, false},
		{"no match: plain interval", true, nil, 0, 0, 0, 0, false, true},
		{"no schedule: plain interval", true, &anilist.Media{Status: "FINISHED"}, 12, 0, 0, 0, false, true},
		{"all aired synced, before release: wait", true, airing(5, now.Add(2*time.Hour)), 4, 0, 0, 0, false, false},
		{"all aired synced, release time reached: check", true, airing(5, now.Add(-10*time.Minute)), 4, 0, 0, 0, false, true},
		{"episode missing: keep checking", true, airing(5, now.Add(2*time.Hour)), 3, 0, 0, 0, false, true},
		// offset maps absolute→local S23: next abs 1157 = local E02, so E01 (abs 1156) has aired
		{"offset caught up: wait", true, airing(1157, now.Add(2*time.Hour)), 1, -1155, 0, 0, false, false},
		{"offset missing: check", true, airing(1157, now.Add(2*time.Hour)), 0, -1155, 0, 0, false, true},
		// Conan-style: from_episode 31, offset -1147, next abs 1186 → 8 aired in part
		{"from_episode caught up: wait", true, airing(1186, now.Add(2*time.Hour)), 8, -1147, 31, 0, false, false},
		{"from_episode missing: check", true, airing(1186, now.Add(2*time.Hour)), 7, -1147, 31, 0, false, true},
		// aired-mapping (endless): local count ignored; caught up while next unreleased
		{"aired before release: wait", true, airing(1171, now.Add(2*time.Hour)), 148, 0, 0, 0, true, false},
		{"aired release reached: check", true, airing(1171, now.Add(-10*time.Minute)), 148, 0, 0, 0, true, true},
		// lang-filter backlog: a skipped remote file whose target is not local yet
		// keeps the watch on the plain interval, even mid-wait
		{"lang backlog, aired mid-wait: check", true, airing(1172, now.Add(2*time.Hour)), 148, 0, 0, 1, true, true},
		{"lang backlog, caught up before release: check", true, airing(5, now.Add(2*time.Hour)), 4, 0, 0, 2, false, true},
		{"lang backlog, interval not reached: still wait", false, airing(5, now.Add(2*time.Hour)), 4, 0, 0, 2, false, false},
		// finished title, nothing left to air: only the 12h stale re-check looks
		// for upgrades, so the plain interval is skipped
		{"finished and fully local: wait", true, finished(12), 12, 0, 0, 0, false, false},
		{"finished, episode missing: check", true, finished(12), 11, 0, 0, 0, false, true},
		{"finished and fully local, lang backlog: check", true, finished(12), 12, 0, 0, 1, false, true},
	}
	for _, c := range cases {
		if got := smartDue(c.intervalDue, c.media, c.have, c.offset, c.fromEpisode, c.filtered, c.aired, watchComplete(c.media, c.have), now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNextCheckAt(t *testing.T) {
	now := time.Now().UTC()
	last := now.Add(-10 * time.Minute)
	stamp := last.Format("2006-01-02 15:04:05")
	// the stamp has second precision, so compare against the truncated value
	lastSec := last.Truncate(time.Second)
	cases := []struct {
		name      string
		lastCheck string
		waiting   bool
		airingAt  int64
		want      int64
	}{
		{"not waiting: one interval after the last check", stamp, false, 0, lastSec.Add(30 * time.Minute).Unix()},
		{"not waiting: an airing slot does not move it", stamp, false, now.Add(2 * time.Hour).Unix(), lastSec.Add(30 * time.Minute).Unix()},
		{"waiting: skips ahead to the airing slot", stamp, true, now.Add(2 * time.Hour).Unix(), now.Add(2 * time.Hour).Unix()},
		{"waiting: an airing already past keeps the interval", stamp, true, now.Add(-2 * time.Hour).Unix(), lastSec.Add(30 * time.Minute).Unix()},
		{"waiting: a far airing is capped by the stale re-check", stamp, true, now.Add(200 * time.Hour).Unix(), lastSec.Add(staleRecheck).Unix()},
		{"waiting without an airing (finished title): stale re-check", stamp, true, 0, lastSec.Add(staleRecheck).Unix()},
		{"never checked: overdue now", "", false, 0, now.Unix()},
	}
	for _, c := range cases {
		if got := nextCheckAt(c.lastCheck, 30*time.Minute, c.waiting, c.airingAt, 0, now); got != c.want {
			t.Errorf("%s: got %d, want %d (%+d s)", c.name, got, c.want, got-c.want)
		}
	}
}

func TestWatchNameFn(t *testing.T) {
	var srv Server // aired mapping off → resolver/DB never touched
	fn := srv.watchNameFn(Watch{Mode: "template", Template: "{title} - S{season:02}E{episode:02}", TitleOverride: "My Show"})
	got := fn("[Grp] Some Show - 05 [1080p].mkv")
	if got != "My Show - S01E05.mkv" {
		t.Errorf("rename: got %q", got)
	}
	// unparseable names keep their original
	if got := fn("readme.txt"); got != "readme.txt" {
		t.Errorf("fallback: got %q", got)
	}
	if srv.watchNameFn(Watch{}) != nil {
		t.Error("empty template must return nil (identity)")
	}
}

func TestEnsureWatchMatchQueuesOnlyUnmatchedFolders(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	s := &Server{DB: d, Anilist: anilist.New(d)}
	db.SetSetting(d, "jobs_paused", "m") // decide only, search nothing
	if !s.ensureWatchMatch(1, "/x/Show", "/media/lib/Show") {
		t.Fatal("an unmatched folder should be queued")
	}
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/Show', 'anilist', 0)`)
	if !s.ensureWatchMatch(1, "/x/Show", "/media/lib/Show") {
		t.Fatal("a stored miss should be searched again")
	}
	d.Exec(`UPDATE catalog_matches SET manual = 1`)
	if s.ensureWatchMatch(1, "/x/Show", "/media/lib/Show") {
		t.Fatal("a manual unmatch must stay")
	}
	d.Exec(`UPDATE catalog_matches SET manual = 0, media_id = 5`)
	if s.ensureWatchMatch(1, "/x/Show", "/media/lib/Show") {
		t.Fatal("a matched folder must not be queued again")
	}
}

// Watches without a row are queued on every start, stored misses once per rule
// set, matched folders never.
func TestBackfillWatchMatches(t *testing.T) {
	d := dbtest.Open(t)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	for _, f := range []string{"/x/A", "/x/B", "/x/C"} {
		d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, ?, '/lib')`, f)
	}
	d.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/B', 'anilist', 0), (1, '/x/C', 'anilist', 5)`)
	s := &Server{DB: d, Anilist: anilist.New(d)}
	db.SetSetting(d, "jobs_paused", "m") // decide only, search nothing
	if n := s.BackfillWatchMatches(); n != 2 {
		t.Fatalf("first start: queued %d, want 2", n)
	}
	if got := db.Setting(d, "watch_match_rules"); got != watchMatchRules {
		t.Fatalf("rule stamp: got %q", got)
	}
	if n := s.BackfillWatchMatches(); n != 1 {
		t.Fatalf("next start: queued %d, want 1 (the folder without a row)", n)
	}
}

// An unscoped watch folder is searched in the source of the Plex library it
// writes into, and a season folder is searched by its show's name.
func TestWatchMatchQuery(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d}
	db.SetSetting(d, "plex_lib_scopes", "/media/series\ttv\n/media/anime\tanime\n/media/anime/films\tmovie")
	tests := []struct {
		folder, local, name, scope string
	}{
		{"/x/Show (2020)", "/media/series/Show (2020)", "Show (2020)", "tv"},
		{"/x/Show (2020)", "/media/series", "Show (2020)", "tv"},
		{"/x/Show/S06", "/media/anime/Show", "Show Season 6", "anime"},
		{"/x/Show/Staffel.5", "/media/series/Show", "Show Season 5", "tv"},
		{"/x/Show/Season 2", "/media/series/Show", "Show Season 2", "tv"},
		{"/x/S Show", "/media/series/S Show", "S Show", "tv"},
		{"/x/Film", "/media/anime/films/Film", "Film", "movie"},
		{"/x/Show", "/elsewhere/Show", "Show", ""},
	}
	for _, tt := range tests {
		name, scope := s.watchMatchQuery(1, tt.folder, tt.local)
		if name != tt.name || scope != tt.scope {
			t.Errorf("%s -> %s: got (%q, %q), want (%q, %q)", tt.folder, tt.local, name, scope, tt.name, tt.scope)
		}
	}
	// a catalog mark on the remote side wins over the library
	d.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/x', 'anime')`)
	if _, scope := s.watchMatchQuery(1, "/x/Show/S02", "/media/series/Show"); scope != "anime" {
		t.Errorf("catalog mark: got %q", scope)
	}
}

func TestLibraryScope(t *testing.T) {
	tests := []struct {
		sec  plex.Section
		src  string
		want string
	}{
		{plex.Section{Type: "show", Title: "Series"}, "tmdb", "tv"},
		{plex.Section{Type: "show", Title: "Series"}, "tvdb", "tvdb"},
		{plex.Section{Type: "show", Title: "Series"}, "anilist+tvdb", "anime"},
		{plex.Section{Type: "movie", Title: "Films"}, "tvdb", "movie"},
		{plex.Section{Type: "movie", Title: "Anime Films"}, "", "anime"},
		{plex.Section{Type: "show", Title: "Series", Provider: "tvdb"}, "", "tvdb"},
		{plex.Section{Type: "show", Title: "Series"}, "", "tv"},
	}
	for _, tt := range tests {
		if got := libraryScope(tt.sec, tt.src); got != tt.want {
			t.Errorf("%+v %q: got %q, want %q", tt.sec, tt.src, got, tt.want)
		}
	}
}

// watchAttention is the one needs-a-hand source; every consumer reads this
// list. Worst first, and expected dub waiting suppresses the language
// backlog without hiding an overdue dub.
func TestWatchAttention(t *testing.T) {
	tests := []struct {
		name string
		w    Watch
		want []string
	}{
		{"nothing wrong", Watch{}, nil},
		{"failed check first", Watch{LastResult: "boom", Behind: 2, BehindLate: true}, []string{"checkFailed", "behind"}},
		{"every reason in order", Watch{
			LastResult: "x", Behind: 1, BehindLate: true, Missing: []EpRef{{1, 4}}, DubOverdue: true,
			LangWaiting: 3, Unsorted: 2, PlexStreamMiss: "audio",
		}, []string{"checkFailed", "behind", "missing", "dubOverdue", "unsorted", "plexStreamMiss"}},
		{"usual upload lag is not attention", Watch{Behind: 1}, nil},
		{"dub not out yet is not attention", Watch{LangWaiting: 3}, nil},
		{"expected dub waiting is not attention", Watch{LangWaiting: 3, DubWaiting: true}, nil},
		{"overdue dub still is", Watch{LangWaiting: 3, DubWaiting: true, DubOverdue: true}, []string{"dubOverdue"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := watchAttention(tt.w)
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Errorf("watchAttention = %v, want %v", got, tt.want)
			}
		})
	}
}
