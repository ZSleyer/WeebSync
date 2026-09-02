package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// The cache exists to stop the hourly library index from re-running ffprobe
// over folders that have not changed. Two things have to hold for that to be
// safe: a hit must return exactly what was measured, and any change to the
// folder - a new episode, a replaced file, a re-encode - must miss, because a
// stale answer would feed the upgrade suggestions a quality the files no
// longer have.
func TestProbeCacheHitsOnlyOnAnUnchangedFolder(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}

	want := FolderQuality{ResRank: 1080, Dub: []string{"jpn"}, Sub: []string{"ger"}, Soft: []string{"ger"}, Probed: probeMeasured}
	s.probeCachePut("/media/Show/Season 01", "12:5000:1700000000", want)

	got, ok := s.probeCacheGet("/media/Show/Season 01", "12:5000:1700000000")
	if !ok {
		t.Fatal("miss on the unchanged folder, want a hit")
	}
	if got.ResRank != want.ResRank || len(got.Dub) != 1 || got.Dub[0] != "jpn" || got.Probed != want.Probed {
		t.Errorf("got %+v, want %+v", got, want)
	}

	// one more file in the folder
	if _, ok := s.probeCacheGet("/media/Show/Season 01", "13:5400:1700000000"); ok {
		t.Error("hit after the folder grew, want a miss")
	}
	// same count and size, but a file was touched (re-encode, replacement)
	if _, ok := s.probeCacheGet("/media/Show/Season 01", "12:5000:1799999999"); ok {
		t.Error("hit after a file changed, want a miss")
	}
	// a folder nobody measured yet
	if _, ok := s.probeCacheGet("/media/Other/Season 01", "12:5000:1700000000"); ok {
		t.Error("hit on an unknown folder, want a miss")
	}

	// re-measuring the same folder replaces the entry rather than failing on
	// the primary key
	s.probeCachePut("/media/Show/Season 01", "13:5400:1700000000", FolderQuality{ResRank: 2160, Probed: probeMeasured})
	got, ok = s.probeCacheGet("/media/Show/Season 01", "13:5400:1700000000")
	if !ok || got.ResRank != 2160 {
		t.Errorf("after re-measuring: ok=%v got=%+v, want the new measurement", ok, got)
	}
}
