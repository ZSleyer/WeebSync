package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
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
