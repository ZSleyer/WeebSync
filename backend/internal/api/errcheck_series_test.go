package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// abortOn makes every statement of the given kind on the table fail, to reach
// the error paths of writes that otherwise always succeed.
func abortOn(t *testing.T, s *Server, event, table string) {
	t.Helper()
	if _, err := s.DB.Exec(`CREATE TRIGGER abort_` + event + `_` + table + ` BEFORE ` + event + ` ON ` + table +
		` BEGIN SELECT RAISE(ABORT, 'forced'); END`); err != nil {
		t.Fatal(err)
	}
}

func TestStoreSeriesTitleReportsFailure(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d}
	if err := s.storeSeriesTitle(1, "tvdb", "de", "x"); err == nil {
		t.Fatal("storing into a missing series should fail on the foreign key")
	}
	if err := s.storeSeriesTitle(1, "tvdb", "", "x"); err != nil {
		t.Fatalf("an empty locale is dropped, not an error: %v", err)
	}
}

func TestSeriesByProviderErrSeparatesNoneFromFailure(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	if id, err := s.seriesByProviderErr("tvdb", 1); id != 0 || err != nil {
		t.Fatalf("no row: got %d, %v", id, err)
	}
	if _, err := s.DB.Exec(`DROP TABLE series_provider`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.seriesByProviderErr("tvdb", 1); err == nil {
		t.Fatal("a failed read passed for none")
	}
}

func TestSeriesInFribbReportsFailedRead(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	refs := []providerRef{{Source: "tvdb", MediaID: 5}}
	if ok, err := s.seriesInFribb(refs); ok || err != nil {
		t.Fatalf("unmapped id: got %v, %v", ok, err)
	}
	if _, err := s.DB.Exec(`DROP TABLE anime_ids`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.seriesInFribb(refs); err == nil {
		t.Fatal("a failed read decided a series is not anime")
	}
}

func TestDetachProviderKeepsProviderWhenMappingCheckFails(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (1, 'k', 'T')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 5, 1)`)
	if _, err := s.DB.Exec(`DROP TABLE anime_ids`); err != nil {
		t.Fatal(err)
	}
	if got := s.detachProvider("tvdb", 5); got != 0 {
		t.Fatalf("detached series %d", got)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'tvdb' AND media_id = 5`).Scan(&n)
	if n != 1 {
		t.Fatal("the provider was dropped although the anime mapping could not be read")
	}
}

func TestDropAnimeLeftoversKeepsIdsWhenReadFails(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	s.DB.Exec(`INSERT INTO series (id, key, title) VALUES (1, 'k', 'T')`)
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id) VALUES (9, 5)`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 5, 1)`)
	if _, err := s.DB.Exec(`DROP TABLE catalog_matches`); err != nil {
		t.Fatal(err)
	}
	refs := []providerRef{{Source: "tvdb", MediaID: 5}}
	if out := s.dropAnimeLeftovers(1, refs); len(out) != 1 {
		t.Fatalf("dropped on a failed read: %v", out)
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE media_id = 5`).Scan(&n)
	if n != 1 {
		t.Fatal("the provider row was deleted")
	}
}

func TestLinkSeriesStopsWhenProviderNotStored(t *testing.T) {
	s := sourceTestServer(t)
	cacheMedia(t, s, "tvdb:media:1", 1, "Rooster", "")
	abortOn(t, s, "INSERT", "series_provider")
	if created, _ := s.linkSeries("tvdb", 1); created {
		t.Fatal("reported a bundle although its provider row was not stored")
	}
}

func TestClearStaleSuggestionCacheKeepsFlagUnsetOnFailure(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	abortOn(t, s, "DELETE", "anilist_cache")
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload) VALUES ('suggestions:1', '{}')`)
	s.ClearStaleSuggestionCache()
	if db.Setting(s.DB, "sugg_fmt") != "" {
		t.Fatal("format stamped although the stale blobs are still there")
	}
}

func TestBackfillUnitsKeepsFlagUnsetOnFailure(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	// a count that cannot be read must not pass for "nothing to fix"
	if _, err := s.DB.Exec(`DROP TABLE catalog_variants`); err != nil {
		t.Fatal(err)
	}
	s.BackfillUnits()
	if db.Setting(s.DB, "units_backfilled_v1") != "" {
		t.Fatal("flag set after a failed count")
	}
}

func TestBackfillUnitsKeepsFlagUnsetWhenStaleRowsStay(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder) VALUES (0, '/lib/x')`)
	abortOn(t, s, "DELETE", "catalog_variants")
	s.BackfillUnits()
	if db.Setting(s.DB, "units_backfilled_v1") != "" {
		t.Fatal("flag set although the stale Plex rows were not dropped")
	}
}
