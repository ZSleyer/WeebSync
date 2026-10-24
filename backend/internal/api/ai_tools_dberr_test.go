package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

// A read that fails inside series_seasons must answer an error, not a
// clean-looking result without copies or auto-syncs: the model would take
// "not in the library, not synced" as fact and propose a duplicate.
func TestAiSeriesSeasonsReportsDBErrors(t *testing.T) {
	seed := func(t *testing.T, d *sql.DB) {
		t.Helper()
		for _, q := range []string{
			`INSERT INTO series (id, key, title, year) VALUES (5, 'frieren', 'Frieren', 2023)`,
			`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 154587, 5), ('tmdb:tv', 209867, 5)`,
			`INSERT INTO series_seasons (series_id, season, title, source, year) VALUES (5, 1, 'Frieren', 'anilist', 2023)`,
			`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, series_id) VALUES (1, '/anime/Frieren', 1080, 'tvdb:1', 1, 5)`,
			`INSERT INTO watches (id, user_id, server_id, remote_path, local_path) VALUES (3, 1, 1, '/anime/Frieren', '/lib')`,
		} {
			if _, err := d.Exec(q); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, c := range []struct {
		name, source string
		media        int
		breakIt      string
	}{
		{"series lookup", "tmdb:tv", 209867, `ALTER TABLE series_provider RENAME TO series_provider_x`},
		{"season row", "anilist", 154587, `INSERT INTO series_seasons (series_id, season, title, source, year) VALUES (5, 'x', 'bad', 'anilist', 2026)`},
		{"copies", "anilist", 154587, `ALTER TABLE servers RENAME TO servers_x`},
		{"copy row", "anilist", 154587, `INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, series_id) VALUES (0, '/lib/x', 1080, 'tvdb:1', 'x', 5)`},
		{"auto-syncs", "anilist", 154587, `ALTER TABLE watches RENAME TO watches_x`},
		{"provider row", "anilist", 154587, `INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 'x', 5)`},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, s, _ := setupAiTest(t, nil)
			seed(t, s.DB)
			// a clean read first, so the break below is what makes the difference
			ok, _ := json.Marshal(s.aiSeriesSeasons(context.Background(), 1, c.source, c.media))
			if strings.Contains(string(ok), `"error"`) {
				t.Fatalf("clean read failed: %s", ok)
			}
			if _, err := s.DB.Exec(c.breakIt); err != nil {
				t.Fatal(err)
			}
			out, _ := json.Marshal(s.aiSeriesSeasons(context.Background(), 1, c.source, c.media))
			if !strings.Contains(string(out), `"error":"db error"`) {
				t.Errorf("failed read passed as data: %s", out)
			}
		})
	}
}
