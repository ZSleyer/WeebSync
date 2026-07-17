package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
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
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
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
	cases := []struct {
		name        string
		intervalDue bool
		media       *anilist.Media
		have        int
		offset      int
		want        bool
	}{
		{"interval not reached", false, nil, 0, 0, false},
		{"no match: plain interval", true, nil, 0, 0, true},
		{"no schedule: plain interval", true, &anilist.Media{Status: "FINISHED"}, 12, 0, true},
		{"all aired synced, before release: wait", true, airing(5, now.Add(2*time.Hour)), 4, 0, false},
		{"all aired synced, release time reached: check", true, airing(5, now.Add(-10*time.Minute)), 4, 0, true},
		{"episode missing: keep checking", true, airing(5, now.Add(2*time.Hour)), 3, 0, true},
		// offset maps absolute→local S23: next abs 1157 = local E02, so E01 (abs 1156) has aired
		{"offset caught up: wait", true, airing(1157, now.Add(2*time.Hour)), 1, -1155, false},
		{"offset missing: check", true, airing(1157, now.Add(2*time.Hour)), 0, -1155, true},
	}
	for _, c := range cases {
		if got := smartDue(c.intervalDue, c.media, c.have, c.offset, now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestWatchNameFn(t *testing.T) {
	fn := watchNameFn(Watch{Mode: "template", Template: "{title} - S{season:02}E{episode:02}", TitleOverride: "My Show"})
	got := fn("[Grp] Some Show - 05 [1080p].mkv")
	if got != "My Show - S01E05.mkv" {
		t.Errorf("rename: got %q", got)
	}
	// unparseable names keep their original
	if got := fn("readme.txt"); got != "readme.txt" {
		t.Errorf("fallback: got %q", got)
	}
	if watchNameFn(Watch{}) != nil {
		t.Error("empty template must return nil (identity)")
	}
}
