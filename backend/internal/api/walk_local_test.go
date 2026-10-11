package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A symlinked folder that leads out of the configured roots yields nothing,
// while a real folder inside the root is walked as before.
func TestWalkLocalRefusesEscapingSymlink(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(outside, "Season 01"), 0o755)
	os.WriteFile(filepath.Join(outside, "Season 01", "S01E01.mkv"), []byte("x"), 0o644)
	if err := os.Symlink(outside, filepath.Join(root, "Show")); err != nil {
		t.Skip(err)
	}
	os.MkdirAll(filepath.Join(root, "Real", "Season 01"), 0o755)
	os.WriteFile(filepath.Join(root, "Real", "Season 01", "S01E01.mkv"), []byte("x"), 0o644)

	s := &Server{DownloadRoot: root, LocalRoots: []string{root}}
	if n := s.countVideos("Show/Season 01", 0); n != 0 {
		t.Fatalf("escaping symlink counted %d videos", n)
	}
	if n := s.countVideos("Real/Season 01", 0); n != 1 {
		t.Fatalf("real folder counted %d videos", n)
	}
	var paths []string
	s.walkEpisodes("Real/Season 01", 0, func(_ int, p string, _ int64) { paths = append(paths, p) })
	if len(paths) != 1 || paths[0] != filepath.Join("Real/Season 01", "S01E01.mkv") {
		t.Fatalf("walkEpisodes paths %v", paths)
	}
	if s.localExists("Show/Season 01/S01E01.mkv") {
		t.Fatal("file behind an escaping symlink reported as existing")
	}
	if !s.localExists("Real/Season 01/S01E01.mkv") {
		t.Fatal("real file reported as missing")
	}
}

// A folder's listing is kept between looks, dropped by a write request, and a
// folder that is not there (a disk not mounted yet) is not kept at all.
func TestLocalVideosCache(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Show", "Season 01")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "S01E01.mkv"), []byte("x"), 0o644)
	s := &Server{DownloadRoot: root, LocalRoots: []string{root}}

	if n := s.countVideos("Show", 0); n != 1 {
		t.Fatalf("first look: %d", n)
	}
	os.WriteFile(filepath.Join(dir, "S01E02.mkv"), []byte("x"), 0o644)
	if n := s.countVideos("Show", 0); n != 1 {
		t.Fatalf("within the TTL the walk is not redone, got %d", n)
	}
	h := s.ForgetLocalOnWrite(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/watches", nil))
	if n := s.countVideos("Show", 0); n != 1 {
		t.Fatalf("a read request kept the listing, got %d", n)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/browse/local/rename", nil))
	if n := s.countVideos("Show", 0); n != 2 {
		t.Fatalf("after a write request: %d", n)
	}

	if n := s.countVideos("Later", 0); n != 0 {
		t.Fatalf("missing folder: %d", n)
	}
	os.MkdirAll(filepath.Join(root, "Later"), 0o755)
	os.WriteFile(filepath.Join(root, "Later", "S01E01.mkv"), []byte("x"), 0o644)
	if n := s.countVideos("Later", 0); n != 1 {
		t.Fatalf("a folder that appeared is seen at once, got %d", n)
	}
}
