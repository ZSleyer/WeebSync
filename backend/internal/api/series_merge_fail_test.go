package api

import "testing"

// A merge that fails is rolled back, and the pass must treat it that way:
// the work stays its own series, so its season name does not go onto the
// show it was not merged into, and the failure is reported to the caller.
func TestMergeShowSeriesSkipsAFailedMerge(t *testing.T) {
	s := mergeTestServer(t)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season) VALUES
		(20474, 262954, 2, 45790, 'tv', 2),
		(21450, 262954, 3, 45790, 'tv', 3)`)
	s.DB.Exec(`INSERT INTO series (id, key, title, year) VALUES
		(1,'jojo no kimyou na bouken stardust crusaders','JoJo no Kimyou na Bouken: Stardust Crusaders',2014),
		(2,'jojo no kimyou na bouken diamond wa kudakenai','JoJo no Kimyou na Bouken: Diamond wa Kudakenai',2016)`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist',20474,1), ('anilist',21450,2)`)
	seedAnilistMedia(t, s, 20474, "JoJo no Kimyou na Bouken: Stardust Crusaders", 2014)
	seedAnilistMedia(t, s, 21450, "JoJo no Kimyou na Bouken: Diamond wa Kudakenai", 2016)
	// every merge fails at its last step, after the moves
	if _, err := s.DB.Exec(`CREATE TRIGGER no_merge BEFORE DELETE ON series BEGIN SELECT RAISE(ABORT, 'locked'); END`); err != nil {
		t.Fatal(err)
	}

	if err := s.mergeSeries(2, 1); err == nil {
		t.Error("a failed merge reported success")
	}

	s.mergeShowSeries(50)
	var series int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series`).Scan(&series)
	if series != 2 {
		t.Fatalf("series = %d, want both kept", series)
	}
	var stray int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_seasons WHERE series_id = 1 AND season = 3`).Scan(&stray)
	if stray != 0 {
		t.Error("the unmerged work's season name was written onto the show")
	}
	var owner int64
	s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = 'anilist' AND media_id = 21450`).Scan(&owner)
	if owner != 2 {
		t.Errorf("the unmerged work moved to series %d", owner)
	}
}
