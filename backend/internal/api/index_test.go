package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
)

func entry(p string, dir bool, size int64, mod time.Time) remote.Entry {
	return remote.Entry{Name: pathBase(p), Path: p, IsDir: dir, Size: size, ModTime: mod}
}

func TestIndexDirAndSearch(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	cookie := cookieForUser(t, d, 1)

	mod := time.Now().Add(-time.Hour)
	s.indexDir(1, "/x", []remote.Entry{
		entry("/x/Show A", true, 0, mod),
		entry("/x/readme.txt", false, 12, mod),
	})
	s.indexDir(1, "/x/Show A", []remote.Entry{
		entry("/x/Show A/Episode 01.mkv", false, 100, mod),
	})

	// search finds files and dirs, case-insensitive, dirs first
	rec := doReq(mux, "GET", "/api/servers/1/search?q=show", "", cookie)
	var out struct {
		Results []remote.Entry `json:"results"`
		Indexed int            `json:"indexed"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Results) != 1 || !out.Results[0].IsDir || out.Results[0].Path != "/x/Show A" {
		t.Fatalf("search: %s", rec.Body)
	}
	if out.Indexed == 0 {
		t.Error("indexed count missing")
	}
	// multi-word AND
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=episode+01", "", cookie); !jsonHasResult(rec.Body.Bytes()) {
		t.Errorf("multi-word: %s", rec.Body)
	}
	// path scopes the search to the folder and what lies below it
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=episode&path=/x/Show+A", "", cookie); !jsonHasResult(rec.Body.Bytes()) {
		t.Errorf("scoped inside: %s", rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=readme&path=/x/Show+A/", "", cookie); jsonHasResult(rec.Body.Bytes()) {
		t.Errorf("scoped outside: %s", rec.Body)
	}
	// re-listing without the file removes it
	s.indexDir(1, "/x/Show A", []remote.Entry{})
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=episode", "", cookie); jsonHasResult(rec.Body.Bytes()) {
		t.Errorf("vanished file still indexed: %s", rec.Body)
	}
	// foreign server 404
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('b@example.com', 0)`)
	cookieB := cookieForUser(t, d, 2)
	if rec := doReq(mux, "GET", "/api/servers/1/search?q=show", "", cookieB); rec.Code != http.StatusNotFound {
		t.Errorf("foreign search: got %d", rec.Code)
	}
}

func jsonHasResult(b []byte) bool {
	var out struct {
		Results []remote.Entry `json:"results"`
	}
	json.Unmarshal(b, &out)
	return len(out.Results) > 0
}

func TestNextCrawlDirs(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)

	mod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// listing /root discovers two dirs, both never listed → both candidates
	s.indexDir(1, "/root", []remote.Entry{
		entry("/root/a", true, 0, mod),
		entry("/root/b", true, 0, mod),
	})
	dirs := s.nextCrawlDirs(1, 10)
	if len(dirs) != 2 {
		t.Fatalf("candidates: %v", dirs)
	}
	// list /root/a → no longer a candidate
	s.indexDir(1, "/root/a", nil)
	// re-list /root with unchanged mtimes → /root/a keeps fresh stamp
	s.indexDir(1, "/root", []remote.Entry{
		entry("/root/a", true, 0, mod),
		entry("/root/b", true, 0, mod),
	})
	dirs = s.nextCrawlDirs(1, 10)
	if len(dirs) != 1 || dirs[0] != "/root/b" {
		t.Fatalf("unchanged child requeued: %v", dirs)
	}
	// mtime of /root/a changes → candidate again
	s.indexDir(1, "/root", []remote.Entry{
		entry("/root/a", true, 0, mod.Add(time.Hour)),
		entry("/root/b", true, 0, mod),
	})
	dirs = s.nextCrawlDirs(1, 10)
	if len(dirs) != 2 {
		t.Fatalf("changed child not requeued: %v", dirs)
	}
}

// A directory the listing no longer shows goes with everything below it, in
// one step - not one level per failed listing slot.
func TestIndexDirDropsVanishedSubtree(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	mod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.indexDir(1, "/r", []remote.Entry{entry("/r/Show_A", true, 0, mod), entry("/r/Show_B", true, 0, mod)})
	s.indexDir(1, "/r/Show_A", []remote.Entry{entry("/r/Show_A/Season 1", true, 0, mod)})
	s.indexDir(1, "/r/Show_A/Season 1", []remote.Entry{entry("/r/Show_A/Season 1/e01.mkv", false, 1, mod)})
	// a sibling whose name starts the same way must not be caught by the prefix
	s.indexDir(1, "/r/Show_B", []remote.Entry{entry("/r/Show_B/e01.mkv", false, 1, mod)})
	s.indexDir(1, "/r", []remote.Entry{entry("/r/Show_B", true, 0, mod)})
	var n int
	d.QueryRow(`SELECT COUNT(*) FROM remote_index WHERE server_id = 1
		AND path IN ('/r/Show_A', '/r/Show_A/Season 1', '/r/Show_A/Season 1/e01.mkv')`).Scan(&n)
	if n != 0 {
		t.Errorf("vanished tree left %d rows", n)
	}
	d.QueryRow(`SELECT COUNT(*) FROM remote_index WHERE server_id = 1
		AND path IN ('/r/Show_B', '/r/Show_B/e01.mkv')`).Scan(&n)
	if n != 2 {
		t.Errorf("sibling lost rows: %d", n)
	}
}

// Every directory runs on its own stamp: an unchanged child is not refreshed
// by its parent's listing, so once its own stamp is a recheck old it is
// listed itself. And a directory past the depth cap is never queued.
func TestNextCrawlDirsOwnStampAndDepth(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	mod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.indexDir(1, "/root", []remote.Entry{entry("/root/a", true, 0, mod)})
	s.indexDir(1, "/root/a", nil)
	// /root/a was listed eight days ago; a fresh parent listing with the same
	// mtime used to stamp it as if it had been listed today
	d.Exec(`UPDATE remote_index SET listed_at = datetime('now', '-8 days') WHERE path = '/root/a'`)
	s.indexDir(1, "/root", []remote.Entry{entry("/root/a", true, 0, mod)})
	if dirs := s.nextCrawlDirs(1, 10); len(dirs) != 1 || dirs[0] != "/root/a" {
		t.Errorf("stale child not requeued after parent listing: %v", dirs)
	}
	// deeper than the cap: known, never listed, and still not a candidate
	deep := "/root" + strings.Repeat("/d", crawlMaxDepth)
	d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, ?, '', 'd', 1)`, deep)
	for _, p := range s.nextCrawlDirs(1, 10) {
		if p == deep {
			t.Errorf("directory past the depth cap queued: %s", p)
		}
	}
}
