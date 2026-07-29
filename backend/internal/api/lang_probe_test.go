package api

import (
	"context"
	"testing"
)

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

// The stall this pins: a measured folder gets its computed_at cleared so the
// next sweep rewrites its row, and until that happens the row still reads
// probed = 0 - so it stays a candidate. Ordered by computed_at, an empty stamp
// sorts first, so the loop kept re-picking the same handful every tick and
// never reached a folder it had not already opened. A cached candidate must
// therefore cost nothing and leave the budget alone.
func TestProbeLoopSkipsWhatItAlreadyMeasured(t *testing.T) {
	s, _ := sizeTestServer(t)
	// one local copy so the remote folders below are upgrade candidates at all
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (0, '/lib/Show', 1080, 'Ger', '', '', '2026-01-01T00:00:00Z', 'tvdb:1', 1, 0, 0, 1, '')`)
	for _, f := range []string{"/seed/A", "/seed/B"} {
		s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
			VALUES (1, ?, 1080, '', '', '', '', 'tvdb:1', 1, 0, 0, 0, '')`, f)
		s.DB.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir)
			VALUES (1, ?, ?, 'ep01.mkv', 0)`, f+"/ep01.mkv", f)
	}
	// A is on record, B has never been opened
	s.cacheSet(langProbeKey(1, "/seed/A/ep01.mkv"), `{"Dub":["Ger"],"Sub":["Ger"]}`)

	// no server is reachable from a test, so any folder the loop actually opens
	// comes back as a failed probe - which is exactly how we can see which one
	// it went for
	s.probeRemoteCandidates(context.Background(), 1)

	var a, b int
	s.DB.QueryRow(`SELECT probed FROM catalog_variants WHERE folder = '/seed/A'`).Scan(&a)
	s.DB.QueryRow(`SELECT probed FROM catalog_variants WHERE folder = '/seed/B'`).Scan(&b)
	if a != int(probeNone) {
		t.Errorf("the cached folder was opened again (probed=%d), so the loop still spends its budget on work it has done", a)
	}
	if b != int(probeFailed) {
		t.Errorf("the unmeasured folder was never reached (probed=%d), so the loop is not advancing", b)
	}
}
