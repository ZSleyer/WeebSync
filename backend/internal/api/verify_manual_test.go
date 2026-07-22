package api

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// TestVerifyUnits is a manual end-to-end check against a real DB copy. Gated by
// WEEBSYNC_VERIFY=<path to weebsync.db copy> so it never runs in CI. It refreshes
// the Fribb mapping, re-derives every remote folder's canonical unit, indexes the
// Plex library per season, and reports how many units have both a local and a
// remote copy (the upgrade/incomplete substrate).
func TestVerifyUnits(t *testing.T) {
	path := os.Getenv("WEEBSYNC_VERIFY")
	if path == "" {
		t.Skip("set WEEBSYNC_VERIFY=<db copy path> to run")
	}
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	defer database.Close()
	var roots []string
	if r := os.Getenv("WEEBSYNC_DOWNLOADS"); r != "" {
		roots = append(roots, r)
	}
	s := &Server{
		DB: database, LocalRoots: roots,
		Anilist: anilist.New(database), Tmdb: tmdb.New(database), Tvdb: tvdb.New(database),
	}

	// 1. Fribb mapping
	s.refreshAnimeIDs()
	var animeN, animeTVDB int
	database.QueryRow(`SELECT COUNT(*) FROM anime_ids`).Scan(&animeN)
	database.QueryRow(`SELECT COUNT(*) FROM anime_ids WHERE tvdb_id != 0`).Scan(&animeTVDB)
	fmt.Printf("anime_ids: %d rows, %d with tvdb\n", animeN, animeTVDB)
	if animeTVDB == 0 {
		t.Fatal("Fribb mapping empty - fetch failed")
	}

	// 2. re-derive every matched folder's unit (remote uses remote_index, no net)
	rows, _ := database.Query(`SELECT server_id, folder FROM catalog_matches WHERE media_id != 0`)
	type f struct {
		sid int64
		dir string
	}
	var folders []f
	for rows.Next() {
		var x f
		rows.Scan(&x.sid, &x.dir)
		folders = append(folders, x)
	}
	rows.Close()
	for _, x := range folders {
		s.refreshVariant(x.sid, x.dir)
	}
	var withKey int
	database.QueryRow(`SELECT COUNT(*) FROM catalog_variants WHERE show_key != ''`).Scan(&withKey)
	fmt.Printf("variants with show_key (remote+local matched): %d\n", withKey)

	// 3. Plex library per season (needs Plex reachable; best effort)
	s.indexPlexLibrary()
	var localUnits int
	database.QueryRow(`SELECT COUNT(*) FROM catalog_variants WHERE server_id = 0 AND show_key != ''`).Scan(&localUnits)
	fmt.Printf("server-0 (Plex) per-season variants: %d\n", localUnits)

	// 4. units with BOTH local and remote (the upgrade/incomplete substrate)
	var both int
	database.QueryRow(`SELECT COUNT(*) FROM (
		SELECT show_key, season FROM catalog_variants WHERE show_key != ''
		GROUP BY show_key, season
		HAVING SUM(CASE WHEN server_id=0 THEN 1 ELSE 0 END) > 0
		   AND SUM(CASE WHEN server_id!=0 THEN 1 ELSE 0 END) > 0)`).Scan(&both)
	fmt.Printf("units with local AND remote: %d\n", both)

	// 5. build suggestions
	ups := s.buildUpgrades(1)
	fmt.Printf("upgrades: %d\n", len(ups))
	for i, up := range ups {
		if i >= 5 {
			break
		}
		fmt.Printf("  UP %s S%d '%s' local[%s %dp] -> remote[%s %dp] res=%v sub=%v dub=%v\n",
			up.ShowKey, up.Season, up.Title, up.From.ServerName, up.From.ResRank,
			up.To.ServerName, up.To.ResRank, up.ImprovesRes, up.ImprovesSub, up.ImprovesDub)
	}
	inc := newAcc()
	s.addMissingUnits(inc)
	miss := inc.list(nil)
	fmt.Printf("missing units (incomplete): %d\n", len(miss))
	for i, m := range miss {
		if i >= 5 {
			break
		}
		fmt.Printf("  MISS %s S%d '%s' cands=%d\n", m.ShowKey, m.Season, m.Title, len(m.Candidates))
	}

	// 6. spot-check: any anime whose Fribb season > 1 (season precision proof)
	scRows, _ := database.Query(`SELECT anilist_id, tvdb_id, tvdb_season FROM anime_ids WHERE tvdb_season > 1 LIMIT 5`)
	fmt.Println("sample anilist->tvdb season>1:")
	for scRows.Next() {
		var al, tv, se int
		scRows.Scan(&al, &tv, &se)
		fmt.Printf("  anilist %d -> tvdb %d season %d\n", al, tv, se)
	}
	scRows.Close()
	_ = context.Background()
}
