package api

import (
	"encoding/json"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

func cacheTvdbGenres(t *testing.T, s *Server, id int, title string, genres ...string) {
	t.Helper()
	m := anilist.Media{ID: id, Status: "FINISHED", Schema: anilist.MediaSchema, Genres: genres}
	m.Title.Romaji = title
	b, _ := json.Marshal(m)
	s.cacheSet("tvdb:media:"+strconv.Itoa(id), string(b))
}

// The anime mapping files Adventure Time: Fionna and Cake's TMDB id under an
// AniList entry. Plex holds that id for the show, so it is no leftover, and
// TVDB, which describes the show itself, decides it is no anime.
func TestFionnaAndCakeKeepsItsPlexIDAndStaysLiveAction(t *testing.T) {
	s := sourceTestServer(t)
	cacheTvdbGenres(t, s, 408850, "Adventure Time: Fionna & Cake", "Animation", "Comedy")
	s.DB.Exec(`INSERT INTO anime_ids (anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind) VALUES (4756, 0, 0, 131378, 'tv')`)
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (64, 'adventure time fionna cake', 'Adventure Time: Fionna & Cake', 'live_action')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 408850, 64), ('tmdb:tv', 131378, 64)`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES (1, '/x/Adventure Time Fionna and Cake (2023)', 'tvdb', 408850)`)
	seedGuidIndex(t, s, `{"adventure time fionna and cake":{"tvdb":408850,"tmdb":131378,"year":2023}}`)

	s.settleSeries("tvdb", 408850)
	var n int
	var kind string
	s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = 'tmdb:tv' AND media_id = 131378`).Scan(&n)
	s.DB.QueryRow(`SELECT kind FROM series WHERE id = 64`).Scan(&kind)
	if n != 1 || kind != kindLive {
		t.Fatalf("tmdb id kept %d, kind %q", n, kind)
	}
}

// A kind decided before stays while TVDB's record is still to be fetched again:
// the whole library went back to the old guesses for half an hour once.
func TestSettleKeepsADecidedKindWhileUndecided(t *testing.T) {
	s := sourceTestServer(t)
	s.cacheSet("tvdb:media:1", `{"id":1,"title":{"romaji":"Show"},"schema":99}`)
	s.DB.Exec(`UPDATE anilist_cache SET fetched_at = '2000-01-01 00:00:00'`) // stale, no genres
	s.DB.Exec(`INSERT INTO series (id, key, title, kind) VALUES (1, 'show', 'Show', 'live_action')`)
	s.DB.Exec(`INSERT INTO series_provider (source, media_id, series_id) VALUES ('tvdb', 1, 1)`)
	s.settleSeries("tvdb", 1)
	var kind string
	s.DB.QueryRow(`SELECT kind FROM series WHERE id = 1`).Scan(&kind)
	if kind != kindLive {
		t.Fatalf("kind %q, want the live_action decided before", kind)
	}
}

// A mark set before marks cleared the rows under them still has its stale
// season row; the one-time repair clears it and lets Plex's ids come back.
func TestRepairCatalogClearsOldMarksAndReconcilesAgain(t *testing.T) {
	s := sourceTestServer(t)
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/LA/Serien', 'tvdb')`)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, source, media_id) VALUES
		(1, '/LA/Serien/Phineas and Ferb (2007)', 'tvdb', 81848),
		(1, '/LA/Serien/Phineas and Ferb (2007)/Staffel.5', 'anilist', 0)`)
	s.DB.Exec(`INSERT INTO plex_reconciled (folder) VALUES ('/LA/Serien/Phineas and Ferb (2007)')`)
	s.RepairCatalog()
	var rows, reconciled int
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches`).Scan(&rows)
	s.DB.QueryRow(`SELECT COUNT(*) FROM plex_reconciled`).Scan(&reconciled)
	if rows != 1 || reconciled != 0 {
		t.Fatalf("rows %d (want only the show), reconciled %d", rows, reconciled)
	}
	if db.Setting(s.DB, "catalog_repairs") != catalogRepairs {
		t.Fatal("repair not stamped")
	}
}
