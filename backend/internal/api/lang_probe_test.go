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

// Being stale is not enough - it has to be taken FIRST. A real catalogue has
// thousands of folders past the recheck window at any moment and the sweep only
// rewrites a few dozen per pass, so an unordered pick left a just-measured
// folder waiting days among them. On the live install 13 cleared stamps were
// competing with 4306 stale folders for 30 slots.
func TestClearedStampIsRefreshedBeforeMerelyStaleOnes(t *testing.T) {
	s, _ := sizeTestServer(t)
	for _, f := range []string{"/seed/Old1", "/seed/Old2", "/seed/Measured", "/seed/Old3"} {
		s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
			VALUES (1, ?, 42, 0, 'anilist')`, f)
		stamp := "2020-01-01T00:00:00Z" // long past the recheck window
		if f == "/seed/Measured" {
			stamp = "" // just measured, asking to be rewritten next
		}
		s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
			VALUES (1, ?, 1080, '', '', '', ?, 'tvdb:1', 1, 0, 0, 0, '')`, f, stamp)
	}

	s.refreshStaleVariants(1, 1) // room for exactly one

	var got string
	s.DB.QueryRow(`SELECT computed_at FROM catalog_variants WHERE folder = '/seed/Measured'`).Scan(&got)
	if got == "" {
		t.Error("the cleared stamp lost its slot to a merely stale folder, so a measurement waits for an arbitrary turn")
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
	if a != int(probeMeasured) {
		t.Errorf("the cached folder came out probed=%d: it must be written straight from the cache, not opened again nor left waiting for the sweep", a)
	}
	if b != int(probeFailed) {
		t.Errorf("the unmeasured folder was never reached (probed=%d), so the loop is not advancing", b)
	}
}

// A build that holds a language gain back marks the copy behind it, so the loop
// opens that one before working through the rest of the catalogue. Without it
// the answer to a card someone has open arrives whenever the background pace
// happens to reach it, which for a full catalogue is a night away.
func TestHeldBackSuggestionJumpsTheProbeQueue(t *testing.T) {
	s, _ := sizeTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (0, '/lib/Show', 1080, 'Jap', '', '', '2026-01-01T00:00:00Z', 'tvdb:1', 1, 0, 0, 1, '')`)
	// a remote copy whose NAME claims a dub the local copy lacks, never measured
	s.DB.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (1, '/seed/Show [GerJapDub]', 1080, 'Ger,Jap', '', '', '2026-01-01T00:00:00Z', 'tvdb:1', 1, 0, 0, 0, '')`)

	if s.wantedProbesPending() {
		t.Fatal("nothing has been asked for yet")
	}
	s.buildUpgrades(1)
	if !s.wantedProbesPending() {
		t.Fatal("a held-back language gain did not ask for its copy to be measured")
	}
	want := s.takeWantedProbes()
	if len(want) != 1 || want[0].folder != "/seed/Show [GerJapDub]" {
		t.Errorf("priority set = %+v, want the remote copy the card is waiting on", want)
	}
	if s.wantedProbesPending() {
		t.Error("taking the set must empty it, or the loop keeps re-reading the same entries")
	}
}
