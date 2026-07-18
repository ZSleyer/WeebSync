// Command matcheval replays the catalog matcher against the cached AniList
// responses of a dev database: for every stored automatic match it computes
// what internal/match would pick today and reports the diff as TSV. Offline
// by default - search results and relations come from the anilist_cache
// table only (any age); -live fetches cache misses from the API.
//
// Usage:
//
//	go run ./cmd/matcheval -db data/weebsync.db -server 2 -prefix '/Anime-Cloud/WEB/' > eval.tsv
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
	_ "modernc.org/sqlite"
)

// seasonDirRe/seasonFromPath mirror the api package (unexported there).
var seasonDirRe = regexp.MustCompile(`\b(\d{4})-([1-4])\b`)

func seasonFromPath(p string) (string, int) {
	for _, seg := range strings.Split(p, "/") {
		if m := seasonDirRe.FindStringSubmatch(seg); m != nil {
			year, _ := strconv.Atoi(m[1])
			return [...]string{"WINTER", "SPRING", "SUMMER", "FALL"}[m[2][0]-'1'], year
		}
	}
	return "", 0
}

// norm mirrors anilist.normQuery: the cache key normalization.
func norm(q string) string {
	return strings.ToLower(strings.Join(strings.Fields(q), " "))
}

var sequelFormats = map[string]bool{"TV": true, "TV_SHORT": true, "ONA": true}

type eval struct {
	db   *sql.DB
	live *anilist.Client // nil = offline
	ctx  context.Context
}

// cachedJSON loads a cache payload regardless of its age: the eval wants the
// data the matcher saw, not a TTL policy.
func (e *eval) cachedJSON(key string, out any) bool {
	var payload string
	if err := e.db.QueryRow(`SELECT payload FROM anilist_cache WHERE key = ?`, key).Scan(&payload); err != nil {
		return false
	}
	return json.Unmarshal([]byte(payload), out) == nil
}

// search resolves one query like the matcher would: cache first, live fetch
// only with -live. found reports whether any answer (even empty) exists.
func (e *eval) search(query, season string, year int) (list []anilist.Media, found bool) {
	key := "search:" + norm(query)
	if season != "" || year != 0 {
		key = fmt.Sprintf("search:%s|%s%d", norm(query), season, year)
	}
	if e.cachedJSON(key, &list) {
		return list, true
	}
	if e.live == nil {
		return nil, false
	}
	list, err := e.live.Search(e.ctx, query)
	if err != nil {
		log.Printf("live search %q: %v", query, err)
		return nil, false
	}
	return list, true
}

// relations resolves SEQUEL edges from the rel2: cache (or live) so a base
// pick for a "S2+" folder can be upgraded along the chain.
func (e *eval) relations(id int) ([]anilist.Relation, bool) {
	var rels []anilist.Relation
	if e.cachedJSON(fmt.Sprintf("rel2:%d", id), &rels) {
		return rels, true
	}
	if e.live == nil {
		return nil, false
	}
	got, err := e.live.RelationsBatch(e.ctx, []int{id})
	if err != nil {
		log.Printf("live relations %d: %v", id, err)
		return nil, false
	}
	return got[id], true
}

// confirmSequel mirrors api.fixSequelPicks for one folder: a pick with a
// PREQUEL edge already is the sequel entry (confirmed as-is), a true base is
// walked along its SEQUEL chain to the wanted season (3 waves max, so up to
// season 4). confirmed=false when the relations cannot vouch for a sequel.
func (e *eval) confirmSequel(base anilist.Media, season int) (anilist.Media, bool) {
	edges, ok := e.relations(base.ID)
	if !ok {
		return base, false
	}
	for _, r := range edges {
		if r.RelationType == "PREQUEL" && (sequelFormats[r.Node.Format] || r.Node.Format == "MOVIE") {
			return base, true // already a sequel entry
		}
	}
	// season-aware walk: "Part 2" entries carry their season's own marker
	// and do not advance the season position (mirrors api.seasonTarget)
	cur, pos := base, 1
	for step := 0; step < 3; step++ {
		rels, ok := e.relations(cur.ID)
		if !ok {
			return base, false
		}
		var next *anilist.Media
		for _, r := range rels {
			if r.RelationType == "SEQUEL" && sequelFormats[r.Node.Format] && r.Node.Status != "NOT_YET_RELEASED" {
				n := r.Node
				next = &n
				break
			}
		}
		if next == nil {
			return base, false
		}
		if so := match.SeasonOf(*next); so > 0 {
			pos = so
		} else {
			pos++
		}
		switch {
		case pos == season:
			return *next, true
		case pos > season:
			return base, false
		}
		cur = *next
	}
	return base, false
}

func (e *eval) mediaTitle(id int) string {
	var m anilist.Media
	if id == 0 || !e.cachedJSON(fmt.Sprintf("media:%d", id), &m) {
		return ""
	}
	if m.Title.English != "" {
		return m.Title.English
	}
	return m.Title.Romaji
}

func title(m anilist.Media) string {
	if m.Title.English != "" {
		return m.Title.English
	}
	return m.Title.Romaji
}

// resolve replays the matcher's attempt chain for one folder and returns the
// media id it would store now. found=false means no cache entry answered any
// attempt (the eval cannot judge this folder offline).
func (e *eval) resolve(folder string) (newID int, newTitle string, found bool) {
	name := path.Base(folder)
	query := match.GuessTitle(name)
	alt := match.GuessAltTitle(name)
	info := match.ParseName(name, query, alt)
	season, year := seasonFromPath(folder)

	// same attempt order as api.matchBatch: season-filtered → plain → alt →
	// normalized → season/OVA markers stripped
	type attempt struct {
		q      string
		season string
		year   int
	}
	attempts := []attempt{}
	if season != "" || year != 0 {
		attempts = append(attempts, attempt{query, season, year})
	}
	attempts = append(attempts, attempt{q: query})
	if alt != "" {
		attempts = append(attempts, attempt{q: alt})
	}
	if nq := match.Normalize(query); nq != norm(query) {
		attempts = append(attempts, attempt{q: nq})
	}
	if info.Season >= 2 || info.OVA {
		if base := match.StripMarkers(query); base != "" && norm(base) != norm(query) {
			attempts = append(attempts, attempt{q: base})
		}
	}
	var list []anilist.Media
	for _, a := range attempts {
		l, ok := e.search(a.q, a.season, a.year)
		found = found || ok
		if len(l) > 0 {
			list = l
			break
		}
	}
	if len(list) == 0 {
		return 0, "", found
	}
	idx, ok := match.Pick(info, list)
	m := list[idx]
	switch {
	case !ok && info.Season >= 2 && match.SeasonOf(m) == 0:
		// rescue: a low-score base pick survives only when the relations
		// confirm the wanted sequel
		up, confirmed := e.confirmSequel(m, info.Season)
		if !confirmed {
			return 0, "", true
		}
		m = up
	case !ok:
		return 0, "", true
	case info.Season >= 2 && match.SeasonOf(m) == 0:
		if up, confirmed := e.confirmSequel(m, info.Season); confirmed {
			m = up
		}
	}
	return m.ID, title(m), true
}

func main() {
	dbPath := flag.String("db", "data/weebsync.db", "path to the weebsync SQLite database (opened read-only)")
	server := flag.Int64("server", 1, "server id whose catalog matches to evaluate")
	prefix := flag.String("prefix", "/Anime-Cloud/WEB/", "only folders under this path")
	live := flag.Bool("live", false, "fetch cache misses from the AniList API (rate-limited)")
	flag.Parse()

	// read-only, no migrations: db.Open would try to write
	d, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatalf("open %s: %v", *dbPath, err)
	}
	defer d.Close()

	e := &eval{db: d, ctx: context.Background()}
	if *live {
		e.live = anilist.New(d) // cache writes fail silently on the ro handle
	}

	rows, err := d.Query(`SELECT folder, media_id FROM catalog_matches
		WHERE server_id = ? AND source = 'anilist' AND manual = 0 AND folder LIKE ? || '%'
		ORDER BY folder`, *server, *prefix)
	if err != nil {
		log.Fatalf("query catalog_matches: %v", err)
	}
	type row struct {
		folder string
		oldID  int
	}
	var matches []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.folder, &r.oldID); err != nil {
			log.Fatalf("scan: %v", err)
		}
		matches = append(matches, r)
	}
	rows.Close()

	clean := strings.NewReplacer("\t", " ", "\n", " ")
	counts := map[string]int{}
	fmt.Println("folder\told_id\told_title\tnew_id\tnew_title\tverdict")
	for _, r := range matches {
		newID, newTitle, found := e.resolve(r.folder)
		verdict := ""
		switch {
		case !found && newID == 0:
			verdict = "no-cache"
		case newID == r.oldID:
			verdict = "same"
		case r.oldID == 0:
			verdict = "was-unmatched-now-matched"
		case newID == 0:
			verdict = "now-unmatched"
		default:
			verdict = "changed"
		}
		counts[verdict]++
		fmt.Printf("%s\t%d\t%s\t%d\t%s\t%s\n",
			r.folder, r.oldID, clean.Replace(e.mediaTitle(r.oldID)), newID, clean.Replace(newTitle), verdict)
	}
	summary := fmt.Sprintf("# total=%d same=%d changed=%d now-unmatched=%d was-unmatched-now-matched=%d no-cache=%d",
		len(matches), counts["same"], counts["changed"], counts["now-unmatched"],
		counts["was-unmatched-now-matched"], counts["no-cache"])
	fmt.Println(summary)
	fmt.Fprintln(os.Stderr, summary)
}
