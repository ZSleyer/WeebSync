package api

import "testing"

// A measurement lands in the probe cache, but a variant row only reads it when
// it is recomputed - and that is gated on computed_at being older than
// variantRecheck. The probe loop therefore empties the stamp, counting on an
// empty string sorting before any RFC3339 cutoff. That comparison is the whole
// mechanism, so it gets a test: without it a folder measured minutes after its
// last refresh keeps its guessed languages for another twelve hours.
func TestClearedStampMakesAVariantStale(t *testing.T) {
	s, _ := sizeTestServer(t)
	for _, f := range []string{"/seed/Measured", "/seed/Fresh"} {
		s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
			VALUES (1, ?, 42, 0, 'anilist')`, f)
	}
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (1, '/seed/Measured', 1080, 'Ger', '', '', '', 'tvdb:1', 1, 0, 0, 0, '')`)
	// far inside variantRecheck, so this one must be left alone
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (1, '/seed/Fresh', 1080, 'Ger', '', '', '2999-01-01T00:00:00Z', 'tvdb:2', 1, 0, 0, 0, '')`)

	s.refreshStaleVariants(1, 10)

	var measured, fresh string
	s.DB.QueryRow(`SELECT computed_at FROM catalog_variants WHERE folder = '/seed/Measured'`).Scan(&measured)
	s.DB.QueryRow(`SELECT computed_at FROM catalog_variants WHERE folder = '/seed/Fresh'`).Scan(&fresh)
	if measured == "" {
		t.Error("a cleared stamp did not make the row stale, so a measurement would sit unread for twelve hours")
	}
	if fresh != "2999-01-01T00:00:00Z" {
		t.Errorf("a fresh row was recomputed anyway: %q", fresh)
	}
}
