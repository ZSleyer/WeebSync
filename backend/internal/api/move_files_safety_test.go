package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

// The update that follows the move can fail - here the new target is already
// another watch of the same remote folder. The files used to be in the new
// folder by then, the watch still on the old, now empty one, and its next
// check fetched the whole series again. Nothing moves unless the watch saves.
func TestWatchMoveNotDoneWhenTheUpdateFails(t *testing.T) {
	s, mux, cookie, root := moveTestServer(t)
	writeFiles(t, filepath.Join(root, "Show"), map[string]int64{"Show - E01.mkv": 1, "Show - E02.mkv": 1})
	for _, q := range []string{
		`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show', 'Show')`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show', 'Show S2')`,
	} {
		if _, err := s.DB.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"Show S2","moveFiles":true}`, cookie)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already exists") {
		t.Errorf("update onto another watch: %d %s, want 409 watch already exists", rec.Code, rec.Body)
	}
	if n := names(t, filepath.Join(root, "Show")); !n["Show - E01.mkv"] || !n["Show - E02.mkv"] {
		t.Errorf("the files left the folder of a watch that was not saved: %v", n)
	}
	if local := watchLocal(t, s, 1); local != "Show" {
		t.Errorf("local_path = %q, want Show", local)
	}
}

// The files moved, then the watch's save failed at its commit: they go back
// to the folder the watch still points at.
func TestWatchMoveUndoneWhenTheSaveFails(t *testing.T) {
	s, _, _, root := moveTestServer(t)
	writeFiles(t, filepath.Join(root, "old"), map[string]int64{"Show - E01.mkv": 1, "Show - E02.mkv": 1})
	res, err := s.moveFolderContents("old", "new", func() error { return errors.New("database is locked") })
	if err == nil || !strings.Contains(err.Error(), "database is locked") || !strings.Contains(err.Error(), "moved back") {
		t.Errorf("move with a failing save: %v, want the save error and that the files went back", err)
	}
	if res.Moved != 0 {
		t.Errorf("moved = %d, want 0 left in the new folder", res.Moved)
	}
	if n := names(t, filepath.Join(root, "old")); !n["Show - E01.mkv"] || !n["Show - E02.mkv"] {
		t.Errorf("old folder: %v, want both episodes back", n)
	}
	if _, err := os.Stat(filepath.Join(root, "new")); !os.IsNotExist(err) {
		t.Errorf("the new folder the move created is still there: %v", err)
	}
}

// One entry cannot be moved (a folder without write permission, a mount of
// its own): the entries moved before it go back, the watch stays on the old
// folder, and the answer says what happened instead of "not moved" while half
// the files sat in the new folder.
func TestWatchMovePartialFailureMovesBack(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	s, mux, cookie, root := moveTestServer(t)
	old := filepath.Join(root, "old")
	writeFiles(t, old, map[string]int64{"a - E01.mkv": 1, "c - E03.mkv": 1})
	stuck := filepath.Join(old, "b extras")
	writeFiles(t, stuck, map[string]int64{"x.mkv": 1})
	// renaming a folder into another parent rewrites its "..": it needs write
	// permission on the folder itself
	if err := os.Chmod(stuck, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(stuck, 0o755) })
	if _, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show', 'old')`); err != nil {
		t.Fatal(err)
	}
	rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"new","moveFiles":true}`, cookie)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "moved back") {
		t.Errorf("partial move: %d %s, want 409 saying the moved entries went back", rec.Code, rec.Body)
	}
	if n := names(t, old); !n["a - E01.mkv"] || !n["b extras"] || !n["c - E03.mkv"] {
		t.Errorf("old folder after the failed move: %v, want everything back", n)
	}
	// the save's writability probe may have made the folder; it holds nothing
	if entries, err := os.ReadDir(filepath.Join(root, "new")); err == nil && len(entries) > 0 {
		t.Errorf("the new folder after the failed move: %v, want empty", entries)
	}
	if local := watchLocal(t, s, 1); local != "old" {
		t.Errorf("local_path = %q, want old", local)
	}
	// a new folder the move itself created goes again with the move
	res, err := s.moveFolderContents("old", "fresh", func() error { return nil })
	if err == nil || res.Moved != 0 {
		t.Errorf("direct move: %+v %v, want an error and nothing moved", res, err)
	}
	if _, err := os.Stat(filepath.Join(root, "fresh")); !os.IsNotExist(err) {
		t.Errorf("the folder the failed move created is still there: %v", err)
	}
}
