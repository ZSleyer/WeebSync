package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestReuseMatch(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	s := &Server{DB: d}
	add := func(serverID int64, folder string, mediaID, manual int, source string) {
		if _, err := d.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
			VALUES (?, ?, ?, ?, ?)`, serverID, folder, mediaID, manual, source); err != nil {
			t.Fatal(err)
		}
	}
	// a name containing LIKE wildcards, to prove the suffix compare is exact
	add(1, "/anime/2026-3 Summer/Show 100%_Fine", 42, 0, "anilist")
	add(2, "/other/Show 100%_Fine", 42, 1, "anilist") // same media: agreement
	add(1, "/anime/Different Show", 99, 0, "anilist")
	add(1, "/anime/Live Thing", 5, 0, "tmdb:tv")

	if id, ok := s.reuseMatch(localServerID, "Show 100%_Fine", "anilist"); !ok || id != 42 {
		t.Errorf("reuseMatch = (%d, %v), want (42, true)", id, ok)
	}
	// a second, contradicting match: one of them is wrong, so search instead
	// of spreading it
	add(3, "/elsewhere/Show 100%_Fine", 777, 1, "anilist")
	if id, ok := s.reuseMatch(localServerID, "Show 100%_Fine", "anilist"); ok {
		t.Errorf("reuseMatch on conflicting matches = %d, want none", id)
	}
	// same folder name, different provider: no cross-source adoption
	if id, ok := s.reuseMatch(localServerID, "Live Thing", "anilist"); ok {
		t.Errorf("reuseMatch across sources = %d, want none", id)
	}
	// a server must not adopt from itself, that row is handled by the caller
	if id, ok := s.reuseMatch(1, "Different Show", "anilist"); ok {
		t.Errorf("reuseMatch from own server = %d, want none", id)
	}
	if _, ok := s.reuseMatch(localServerID, "Nothing Here", "anilist"); ok {
		t.Error("reuseMatch found a match for an unknown name")
	}
	// a stored "no match" (media_id 0) must not be adopted as a result
	add(1, "/anime/Unmatched", 0, 0, "anilist")
	if _, ok := s.reuseMatch(localServerID, "Unmatched", "anilist"); ok {
		t.Error("reuseMatch adopted a zero match")
	}
}
