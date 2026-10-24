package api

import (
	"context"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// The one-off startup jobs ran to the end whatever happened: a SIGTERM during
// a long backfill waited out the shutdown budget and closed the database under
// it. They now stop with the server's lifetime, and a pass that stopped early
// leaves its stamp unset so the next start does it again.
func TestStartupJobsStopAtShutdown(t *testing.T) {
	s, _ := sizeTestServer(t)
	for _, q := range []string{
		`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/x/Show', 5, 'tvdb')`,
		`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season) VALUES (1, '/x/Show', 1080, '', 1)`,
		`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/x', 'tvdb')`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/x/Show', '/lib/Show')`,
	} {
		if _, err := s.DB.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	s.Shutdown(context.Background())

	s.BackfillSeries()
	s.SettleMatchedSeries()
	s.RepairCatalog()
	s.RevalidateMatches()
	s.BackfillUnits()
	s.BackfillWatchMatches()
	for key, done := range map[string]string{
		"series_backfilled":   "1",
		"series_rules":        seriesRules,
		"catalog_repairs":     catalogRepairs,
		"match_rules":         matchRules,
		"units_backfilled_v1": "1",
		"watch_match_rules":   watchMatchRules,
	} {
		if db.Setting(s.DB, key) == done {
			t.Errorf("%s stamped by a pass that ran after shutdown began", key)
		}
	}
}
