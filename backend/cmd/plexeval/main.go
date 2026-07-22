// Command plexeval measures our catalog matches against Plex's own authoritative
// provider guids (tvdb://, tmdb://). For every TVDB/TMDB match it maps the folder
// to a Plex show by title, then compares our stored media id to the id Plex
// assigned. This is the ground-truth accuracy signal that drives match fixes.
//
// It reads the dev database read-only and talks to the Plex server configured in
// its settings (plex_url/plex_token, both plaintext). AniList matches have no
// direct Plex id and are reported as a separate, un-judged bucket.
//
// Usage:
//
//	go run ./cmd/plexeval -db data/weebsync.db > plexeval.tsv
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/plex"
	_ "modernc.org/sqlite"
)

// plexIDs is the authoritative provider id pair Plex holds for one show.
type plexIDs struct {
	tvdb, tmdb, year int
	title            string
}

// folderYearRe reads a "(2023)" year suffix so a title collision between a
// remake and the original (same folded title, different year) is not counted as
// a mismatch.
var folderYearRe = regexp.MustCompile(`\((19|20)\d{2}\)`)

func folderYear(base string) int {
	if m := folderYearRe.FindString(base); m != "" {
		n, _ := strconv.Atoi(strings.Trim(m, "()"))
		return n
	}
	return 0
}

// buildIndex folds every Plex show/movie title to its provider ids. Two titles
// that fold equal collapse (last wins); acceptable for an accuracy estimate.
func buildIndex(c *plex.Client) (map[string]plexIDs, error) {
	secs, err := c.Sections()
	if err != nil {
		return nil, err
	}
	idx := map[string]plexIDs{}
	shows := 0
	for _, sec := range secs {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		list, err := c.Shows(sec.Key)
		if err != nil {
			log.Printf("shows %q: %v", sec.Title, err)
			continue
		}
		for _, sh := range list {
			ids := plexIDs{tvdb: sh.TVDBID, tmdb: sh.TMDBID, year: sh.Year, title: sh.Title}
			for _, t := range []string{sh.Title, sh.OriginalTitle} {
				if k := match.FoldKey(t); k != "" {
					idx[k] = ids
				}
			}
			shows++
		}
	}
	log.Printf("indexed %d Plex shows/movies, %d fold keys", shows, len(idx))
	return idx, nil
}

func main() {
	dbPath := flag.String("db", "data/weebsync.db", "path to the weebsync SQLite database (read-only)")
	verbose := flag.Bool("v", false, "print every row, not just mismatches")
	flag.Parse()

	d, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatalf("open %s: %v", *dbPath, err)
	}
	defer d.Close()

	var url, token string
	d.QueryRow(`SELECT value FROM settings WHERE key='plex_url'`).Scan(&url)
	d.QueryRow(`SELECT value FROM settings WHERE key='plex_token'`).Scan(&token)
	if url == "" || token == "" {
		log.Fatal("plex_url/plex_token not set in settings")
	}
	idx, err := buildIndex(plex.New(url, token))
	if err != nil {
		log.Fatalf("plex index: %v", err)
	}

	rows, err := d.Query(`SELECT server_id, folder, media_id, source FROM catalog_matches
		WHERE media_id != 0 ORDER BY folder`)
	if err != nil {
		log.Fatalf("query catalog_matches: %v", err)
	}
	defer rows.Close()

	counts := map[string]int{}
	clean := strings.NewReplacer("\t", " ", "\n", " ")
	fmt.Println("folder\tsource\tour_id\tplex_id\tplex_title\tverdict")
	for rows.Next() {
		var serverID int64
		var folder, source string
		var mediaID int
		if rows.Scan(&serverID, &folder, &mediaID, &source) != nil {
			continue
		}
		ids, ok := idx[match.FoldKey(match.GuessTitle(path.Base(folder)))]
		if !ok {
			counts["no-plex-match"]++
			continue
		}
		// For tvdb/tmdb sources we can compare our id to Plex's directly.
		// AniList has no Plex id; instead we report whether Plex can supply an
		// authoritative tvdb/tmdb id for the same show - the enrichment/bridge
		// that lets reconcilePlex bundle the series cross-provider.
		if source == "anilist" {
			switch {
			case ids.tvdb != 0:
				counts["anilist-plex-tvdb"]++
			case ids.tmdb != 0:
				counts["anilist-plex-tmdb"]++
			default:
				counts["anilist-plex-noid"]++
			}
			if *verbose {
				fmt.Printf("%s\t%s\t%d\ttvdb:%d/tmdb:%d\t%s\tbridge\n",
					clean.Replace(path.Base(folder)), source, mediaID, ids.tvdb, ids.tmdb, clean.Replace(ids.title))
			}
			continue
		}
		// year gate: a folder and a Plex show that fold to the same title but
		// sit years apart are different shows (remake vs original), not a match
		// to judge
		if fy := folderYear(path.Base(folder)); fy != 0 && ids.year != 0 && abs(fy-ids.year) > 1 {
			counts["diff-year-skip"]++
			continue
		}
		plexID := ids.tvdb
		if strings.HasPrefix(source, "tmdb:") {
			plexID = ids.tmdb
		}
		verdict := "match"
		switch {
		case plexID == 0:
			verdict = "no-plex-id"
		case plexID != mediaID:
			verdict = "MISMATCH"
		}
		counts[verdict]++
		if *verbose || verdict == "MISMATCH" {
			fmt.Printf("%s\t%s\t%d\t%d\t%s\t%s\n",
				clean.Replace(path.Base(folder)), source, mediaID, plexID, clean.Replace(ids.title), verdict)
		}
	}
	judged := counts["match"] + counts["MISMATCH"]
	acc := 0.0
	if judged > 0 {
		acc = 100 * float64(counts["match"]) / float64(judged)
	}
	summary := fmt.Sprintf("# tvdb/tmdb: judged=%d match=%d mismatch=%d accuracy=%.1f%% no-plex-id=%d\n"+
		"# anilist bridge: plex-tvdb=%d plex-tmdb=%d plex-noid=%d | no-plex-match(all)=%d",
		judged, counts["match"], counts["MISMATCH"], acc, counts["no-plex-id"],
		counts["anilist-plex-tvdb"], counts["anilist-plex-tmdb"], counts["anilist-plex-noid"],
		counts["no-plex-match"])
	fmt.Println(summary)
	fmt.Fprintln(os.Stderr, summary)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
