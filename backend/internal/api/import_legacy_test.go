package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

func TestLegacyImport(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	root := t.TempDir()
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, root)}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookie := cookieForUser(t, d, 1)

	// dry run: convert only, nothing written
	body := `{"dryRun":true,"localRoot":"anime","config":{
		"autoSyncIntervalInMinutes": 45,
		"server": {"host":"example.com","port":21,"user":"u","password":"p"},
		"syncMaps": [
			{"id":"One Piece","originFolder":"/remote/op","destinationFolder":"D:/anime/One Piece",
			 "fileRegex":".*? E([0-9]+).*","fileRenameTemplate":"{{$syncName}} - S23E{{renumber $1 1155}}","rename":true},
			{"id":"Plain","originFolder":"/remote/plain","destinationFolder":"D:/anime/Plain","rename":false}
		]}}`
	rec := doReq(mux, "POST", "/api/import/legacy", body, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("dry run: %d %s", rec.Code, rec.Body)
	}
	var plan LegacyPlan
	if err := json.Unmarshal(rec.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Server.Protocol != "sftp" || plan.IntervalMin != 45 {
		t.Errorf("plan = %+v", plan)
	}
	if len(plan.Watches) != 2 || plan.Watches[0].Template != "{title} - S23E{episode-1155:02}" {
		t.Fatalf("watches = %+v", plan.Watches)
	}
	if plan.Watches[0].LocalPath != "anime/One Piece" {
		t.Errorf("localPath = %q", plan.Watches[0].LocalPath)
	}
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM watches`).Scan(&n)
	if n != 0 {
		t.Fatalf("dry run wrote %d watches", n)
	}

	// commit onto the existing server
	plan.Watches = append(plan.Watches, LegacyWatchPlan{ID: "bogus", RemotePath: "/x", LocalPath: "anime", Mode: "nope"})
	commit, _ := json.Marshal(LegacyImportRequest{
		ServerID: 1, IntervalMin: plan.IntervalMin, Watches: plan.Watches,
	})
	rec = doReq(mux, "POST", "/api/import/legacy", string(commit), cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("commit: %d %s", rec.Code, rec.Body)
	}
	var res LegacyImportResult
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Imported != 2 || res.Skipped != 1 {
		t.Errorf("result = %+v", res)
	}
	var mode, tmpl string
	d.QueryRow(`SELECT mode, template FROM watches WHERE remote_path = '/remote/op'`).Scan(&mode, &tmpl)
	if mode != "template" || tmpl != "{title} - S23E{episode-1155:02}" {
		t.Errorf("stored mode %q template %q", mode, tmpl)
	}
	if got := db.Setting(d, "watch_interval_min"); got != "45" {
		t.Errorf("watch_interval_min = %q", got)
	}
}

// A commit without a server must not silently create one.
func TestLegacyImportNeedsServer(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d, DownloadRoot: t.TempDir(), Anilist: anilist.New(d)}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	rec := doReq(mux, "POST", "/api/import/legacy", `{"watches":[]}`, cookieForUser(t, d, 1))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	// and an unauthenticated call is rejected outright
	r := httptest.NewRequest("POST", "/api/import/legacy", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d", w.Code)
	}
}
