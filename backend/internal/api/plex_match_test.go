package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestAnilistFromSeries(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	s := &Server{DB: d}

	series := func(id int64, key string) {
		if _, err := d.Exec(`INSERT INTO series (id, key) VALUES (?, ?)`, id, key); err != nil {
			t.Fatal(err)
		}
	}
	prov := func(source string, mediaID int, seriesID int64) {
		if _, err := d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES (?, ?, ?)`, source, mediaID, seriesID); err != nil {
			t.Fatal(err)
		}
	}
	anime := func(anilistID, tvdb, tvdbSeason int) {
		if _, err := d.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season) VALUES (?, ?, ?)`, anilistID, tvdb, tvdbSeason); err != nil {
			t.Fatal(err)
		}
	}

	// single-season series: unambiguous adoption via tvdb id
	series(1, "one")
	prov("tvdb", 500, 1)
	prov("anilist", 42, 1)
	if id, ok := s.anilistFromSeries(500, 0, 1); !ok || id != 42 {
		t.Fatalf("single season: got %d,%v want 42,true", id, ok)
	}

	// multi-season series: pick the AniList id whose Fribb tvdb_season matches
	series(2, "two")
	prov("tvdb", 600, 2)
	prov("anilist", 10, 2)
	prov("anilist", 11, 2)
	anime(10, 600, 1)
	anime(11, 600, 2)
	if id, ok := s.anilistFromSeries(600, 0, 2); !ok || id != 11 {
		t.Fatalf("season 2: got %d,%v want 11,true", id, ok)
	}
	if id, ok := s.anilistFromSeries(600, 0, 1); !ok || id != 10 {
		t.Fatalf("season 1: got %d,%v want 10,true", id, ok)
	}
	// ambiguous season (no Fribb row matches) → no guess
	if _, ok := s.anilistFromSeries(600, 0, 5); ok {
		t.Fatal("season 5: expected no match (ambiguous)")
	}
	// unknown id
	if _, ok := s.anilistFromSeries(999, 0, 1); ok {
		t.Fatal("unknown tvdb: expected no match")
	}
}

func TestAnilistFromAnimeIDs(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	s := &Server{DB: d}
	add := func(anilistID, tvdb, tvdbSeason, tmdb int, kind string) {
		if _, err := d.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind) VALUES (?, ?, ?, ?, ?)`,
			anilistID, tvdb, tvdbSeason, tmdb, kind); err != nil {
			t.Fatal(err)
		}
	}

	// single tvdb row → direct
	add(70, 700, 1, 0, "")
	if id, ok := s.anilistFromAnimeIDs(700, 0, 1); !ok || id != 70 {
		t.Fatalf("single tvdb: got %d,%v want 70,true", id, ok)
	}

	// two AniList ids share one tvdb id → season disambiguates
	add(80, 800, 1, 0, "")
	add(81, 800, 2, 0, "")
	if id, ok := s.anilistFromAnimeIDs(800, 0, 2); !ok || id != 81 {
		t.Fatalf("tvdb season 2: got %d,%v want 81,true", id, ok)
	}
	if _, ok := s.anilistFromAnimeIDs(800, 0, 9); ok {
		t.Fatal("tvdb season 9: expected no match (ambiguous)")
	}

	// tmdb fallback (tv only)
	add(90, 0, 1, 900, "tv")
	if id, ok := s.anilistFromAnimeIDs(0, 900, 1); !ok || id != 90 {
		t.Fatalf("tmdb tv: got %d,%v want 90,true", id, ok)
	}

	// zero ids resolve to nothing
	if _, ok := s.anilistFromAnimeIDs(0, 0, 1); ok {
		t.Fatal("zero ids: expected no match")
	}
}
