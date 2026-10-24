package api

import (
	"testing"
	"time"
)

// A non-ASCII library path must still find its trashed copy: SQLite's substr
// counts characters, so the prefix length passed in must too.
func TestReplacedCopyNonASCIIPath(t *testing.T) {
	s := sourceTestServer(t)
	at := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	trash := "/media/Höhle der Löwen/" + trashDir + "/"
	s.DB.Exec(`INSERT INTO trash_files (path, trashed_at) VALUES (?, ?)`, trash+"Show - S01E03.mkv", at.Unix())
	got := s.replacedCopy("/media/Höhle der Löwen/Show - S01E03.mkv", at.Format("2006-01-02 15:04:05"))
	if got != "Show - S01E03.mkv" {
		t.Errorf("replacedCopy = %q, want the trashed copy", got)
	}
}
