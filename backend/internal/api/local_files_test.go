package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func (c *localCache) listing(rel string) *localListing {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.all[rel]
}

// within waits up to a second for the folder cache to catch up with a change.
func within(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("%s: not seen within a second", what)
}

// A watched folder is listed once and read again on a change only: a new file,
// a file in a new subfolder, a removal. A folder that is not there (a disk not
// mounted yet) is not kept and is seen the moment it appears.
func TestLocalFilesWatched(t *testing.T) {
	root := t.TempDir()
	if !watchable(root) {
		t.Skip("temp dir on a file system inotify does not cover")
	}
	show := filepath.Join(root, "Show")
	os.MkdirAll(filepath.Join(show, "Season 01"), 0o755)
	os.WriteFile(filepath.Join(show, "Season 01", "S01E01.mkv"), []byte("x"), 0o644)
	s := testServer(t, &Server{DownloadRoot: root, LocalRoots: []string{root}})

	if n := s.countVideos("Show", 0); n != 1 {
		t.Fatalf("first look: %d", n)
	}
	l := s.localCache.listing("Show")
	if l == nil || !l.watched {
		t.Fatal("listing not kept as watched")
	}
	if s.countVideos("Show", 0); s.localCache.listing("Show") != l {
		t.Fatal("an unchanged folder was read again")
	}

	os.WriteFile(filepath.Join(show, "Season 01", "S01E02.mkv"), []byte("x"), 0o644)
	within(t, "new file", func() bool { return s.countVideos("Show", 0) == 2 })

	// a subfolder made after the walk has no watch of its own yet
	os.MkdirAll(filepath.Join(show, "Season 02"), 0o755)
	within(t, "new subfolder", func() bool { return s.countVideos("Show", 0) == 2 && s.localCache.listing("Show") != nil })
	os.WriteFile(filepath.Join(show, "Season 02", "S02E01.mkv"), []byte("x"), 0o644)
	within(t, "file in the new subfolder", func() bool { return s.countVideos("Show", 0) == 3 })

	os.Remove(filepath.Join(show, "Season 01", "S01E01.mkv"))
	within(t, "removal", func() bool { return s.countVideos("Show", 0) == 2 })

	if n := s.countVideos("Later", 0); n != 0 {
		t.Fatalf("missing folder: %d", n)
	}
	os.MkdirAll(filepath.Join(root, "Later"), 0o755)
	os.WriteFile(filepath.Join(root, "Later", "S01E01.mkv"), []byte("x"), 0o644)
	if n := s.countVideos("Later", 0); n != 1 {
		t.Fatalf("a folder that appeared is seen at once, got %d", n)
	}
}
