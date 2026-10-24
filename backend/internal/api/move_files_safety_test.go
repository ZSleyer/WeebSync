package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// moveTestServer is the server of TestWatchUpdateMovesFiles: an admin, one
// SFTP server that cannot be reached, a download root as the only media root.
func moveTestServer(t *testing.T) (*Server, *http.ServeMux, *http.Cookie, string) {
	t.Helper()
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
	for _, q := range []string{
		`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`,
		`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
			VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return s, mux, cookieForUser(t, d, 1), root
}

func watchLocal(t *testing.T, s *Server, id int64) string {
	t.Helper()
	var local string
	if err := s.DB.QueryRow(`SELECT local_path FROM watches WHERE id = ?`, id).Scan(&local); err != nil {
		t.Fatal(err)
	}
	return local
}

// The trash folder belongs to the folder, not to the watch: moving it along
// left its rows pointing at the old place, and the copies in it were never
// listed or swept again. It stays, and the trash page still has it.
func TestWatchMoveLeavesTheTrashFolder(t *testing.T) {
	s, mux, cookie, root := moveTestServer(t)
	writeFiles(t, filepath.Join(root, "old"), map[string]int64{"Show - E01.mkv": 1, "Show - E02.mkv": 1})
	if err := s.trashPath(filepath.Join(root, "old", "Show - E02.mkv"), trashWhy{Reason: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show', 'old')`); err != nil {
		t.Fatal(err)
	}
	rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"new","moveFiles":true}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("move: %d %s", rec.Code, rec.Body)
	}
	moved := names(t, filepath.Join(root, "new"))
	if !moved["Show - E01.mkv"] {
		t.Error("the episode should have moved")
	}
	if moved[trashDir] {
		t.Errorf("the trash folder moved along: %v", moved)
	}
	paths, _, err := s.trashRows()
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 {
		t.Fatalf("trash rows: %v", paths)
	}
	local, ok := s.trashed(paths[0])
	if !ok {
		t.Fatalf("the trash row %s is no longer acted on", paths[0])
	}
	defer local.Close()
	if _, err := local.Root.Stat(local.Name); err != nil {
		t.Errorf("the trash row %s no longer points at its copy: %v", paths[0], err)
	}
}

// Two watches can fill one folder (parts of a season). Moving one of them
// took the other's episodes along, and that watch fetched them all again.
// The move is refused before anything moves.
func TestWatchMoveRefusedForASharedFolder(t *testing.T) {
	s, mux, cookie, root := moveTestServer(t)
	writeFiles(t, filepath.Join(root, "Season 01"), map[string]int64{"Show - E01.mkv": 1, "Show - E13.mkv": 1})
	for _, q := range []string{
		`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show Part 1', 'Season 01')`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show Part 2', 'Season 01')`,
	} {
		if _, err := s.DB.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show Part 1","localPath":"Part 1","moveFiles":true}`, cookie)
	if rec.Code != http.StatusConflict {
		t.Errorf("move out of a shared folder: %d %s, want 409", rec.Code, rec.Body)
	}
	if n := names(t, filepath.Join(root, "Season 01")); !n["Show - E01.mkv"] || !n["Show - E13.mkv"] {
		t.Errorf("files left the shared folder: %v", n)
	}
	if local := watchLocal(t, s, 1); local != "Season 01" {
		t.Errorf("local_path = %q, want unchanged", local)
	}
}
