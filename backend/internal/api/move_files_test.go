package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A watch moved to a new target takes its files along when asked: everything
// in the old folder lands in the new one, a name the new folder already has
// stays behind, and the empty old folder goes. Without the flag nothing moves.
func TestWatchUpdateMovesFiles(t *testing.T) {
	d := dbtest.Open(t)
	root := t.TempDir()
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{DB: d, DownloadRoot: root, LocalRoots: []string{root}, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, root)}
	drainJobsAtCleanup(t, s)
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookie := cookieForUser(t, d, 1)

	write := func(rel string) {
		p := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(rel), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old/Show - E01.mkv")
	write("old/Show - E02.mkv")
	write("new/Show - E02.mkv") // already there: kept, not overwritten

	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"old"}`, cookie); rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	// without moveFiles the files stay
	if rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"elsewhere"}`, cookie); rec.Code != http.StatusOK {
		t.Fatalf("plain update: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(root, "old/Show - E01.mkv")); err != nil {
		t.Fatalf("a plain update moved files: %v", err)
	}
	d.Exec(`UPDATE watches SET local_path = 'old'`)

	rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"new","moveFiles":true}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("move: %d %s", rec.Code, rec.Body)
	}
	var out watchUpdateResponse
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Moved == nil || out.Moved.Moved != 1 || len(out.Moved.Kept) != 1 || out.Moved.Kept[0] != "Show - E02.mkv" {
		t.Fatalf("moved = %+v, want one moved and E02 kept", out.Moved)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "new/Show - E01.mkv")); string(b) != "old/Show - E01.mkv" {
		t.Errorf("E01 not in the new folder")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "new/Show - E02.mkv")); string(b) != "new/Show - E02.mkv" {
		t.Errorf("the new folder's E02 was overwritten")
	}
	if _, err := os.Stat(filepath.Join(root, "old/Show - E02.mkv")); err != nil {
		t.Errorf("the kept E02 should stay in the old folder: %v", err)
	}
	var local string
	d.QueryRow(`SELECT local_path FROM watches WHERE id = 1`).Scan(&local)
	if local != "new" {
		t.Errorf("local_path = %q, want new", local)
	}

	// a target inside the old folder is refused, and the watch stays put
	if rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"new/inner","moveFiles":true}`, cookie); rec.Code != http.StatusConflict {
		t.Errorf("move into itself: %d, want 409", rec.Code)
	}
	d.QueryRow(`SELECT local_path FROM watches WHERE id = 1`).Scan(&local)
	if local != "new" {
		t.Errorf("a refused move changed local_path to %q", local)
	}
}
