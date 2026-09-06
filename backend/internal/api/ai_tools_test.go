package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestAiLibraryDownloadsAiring(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	d := s.DB
	d.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, sub_codes, show_key, season) VALUES (0, '/lib/Anime/Frieren/Season 1', 1080, 'Ger,Jap', 'Ger', 'tvdb:1', 1)`)
	d.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season) VALUES (0, '/lib/Anime/Other/Season 1', 720, 'tvdb:2', 1)`)
	d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, size, transferred) VALUES (1, 1, '/anime/Frieren/ep1.mkv', '/lib', 'running', 1000, 250)`)
	d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, error, error_code) VALUES (1, 1, '/anime/Frieren/ep2.mkv', '/lib', 'error', 'disk full', 'nospace')`)
	d.Exec(`INSERT INTO watches (id, user_id, server_id, remote_path, local_path, title_override) VALUES (7, 1, 1, '/anime/Frieren', '/lib', 'Frieren')`)

	lib, _ := json.Marshal(s.aiLibrary(1, "frieren"))
	if !strings.Contains(string(lib), `"/lib/Anime/Frieren/Season 1"`) || !strings.Contains(string(lib), `"1080p"`) || strings.Contains(string(lib), "Other") {
		t.Errorf("library: %s", lib)
	}
	if e, _ := json.Marshal(s.aiLibrary(1, "")); !strings.Contains(string(e), "query required") {
		t.Errorf("library without query: %s", e)
	}

	dl, _ := json.Marshal(s.aiDownloads(1, ""))
	for _, want := range []string{`"file":"ep1.mkv"`, `"progress":"25%"`, `"errorCode":"nospace"`, `"counts":{"error":1,"running":1}`} {
		if !strings.Contains(string(dl), want) {
			t.Errorf("downloads: missing %s in %s", want, dl)
		}
	}
	if only, _ := json.Marshal(s.aiDownloads(1, "error")); strings.Contains(string(only), "ep1.mkv") || !strings.Contains(string(only), "ep2.mkv") {
		t.Errorf("downloads filter: %s", only)
	}
	if bad, _ := json.Marshal(s.aiDownloads(1, "weird")); !strings.Contains(string(bad), "status must be") {
		t.Errorf("downloads bad status: %s", bad)
	}

	air, _ := json.Marshal(s.aiAiring(1, 0))
	if !strings.Contains(string(air), `"days":14`) || !strings.Contains(string(air), `"title":"Frieren"`) || !strings.Contains(string(air), `"id":7`) {
		t.Errorf("airing: %s", air)
	}
	st := toolStats("airing", air)
	if st["count"] != 1 {
		t.Errorf("airing stats: %v", st)
	}
}

func TestAiSeriesSeasonsFromTheBundle(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	d := s.DB
	d.Exec(`INSERT INTO series (id, key, title, year) VALUES (5, 'frieren', 'Frieren', 2023)`)
	d.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('anilist', 154587, 5), ('anilist', 190000, 5)`)
	d.Exec(`INSERT INTO series_seasons (series_id, season, title, source, year) VALUES (5, 1, 'Frieren', 'anilist', 2023), (5, 2, 'Frieren Season 2', 'anilist', 2026)`)
	// season 1 is local, season 2 sits on the server and has an auto-sync
	d.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, show_key, season, series_id) VALUES (0, '/lib/Anime/Frieren/Season 1', 1080, 'tvdb:1', 1, 5)`)
	d.Exec(`INSERT INTO catalog_variants (server_id, folder, res_rank, dub_codes, show_key, season, series_id) VALUES (1, '/anime/Frieren', 2160, 'Ger', 'tvdb:1', 2, 5)`)
	d.Exec(`INSERT INTO watches (id, user_id, server_id, remote_path, local_path) VALUES (3, 1, 1, '/anime/Frieren', '/lib')`)

	out, _ := json.Marshal(s.aiSeriesSeasons(context.Background(), 1, "anilist", 154587))
	got := string(out)
	for _, want := range []string{`"series":"Frieren"`, `"season":1`, `"local":[{`, `"/lib/Anime/Frieren/Season 1"`, `"season":2`, `"remote":[{"serverId":1,"serverName":"srv","path":"/anime/Frieren","resolution":"4K"`, `"inAutoSync":true`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	st := toolStats("series_seasons", out)
	if st["count"] != 2 || st["local"] != 1 || st["remote"] != 1 {
		t.Errorf("stats: %v", st)
	}
	if e, _ := json.Marshal(s.aiSeriesSeasons(context.Background(), 1, "tmdb:tv", 99)); !strings.Contains(string(e), "not bundled") {
		t.Errorf("unbundled tmdb: %s", e)
	}
}
