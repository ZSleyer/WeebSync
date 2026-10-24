package api

import (
	"log/slog"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/match"
)

var plexYearRe = regexp.MustCompile(`\((19|20)\d{2}\)`)

// folderYearOf reads a "(2023)" year suffix from a folder name, 0 when absent.
func folderYearOf(base string) int {
	if m := plexYearRe.FindString(base); m != "" {
		n, _ := strconv.Atoi(strings.Trim(m, "()"))
		return n
	}
	return 0
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// plexGuid is the authoritative provider identity Plex holds for one show.
type plexGuid struct {
	TVDB      int    `json:"tvdb"`
	TMDB      int    `json:"tmdb"`
	IMDB      int    `json:"imdb"`
	Year      int    `json:"year"`
	RatingKey string `json:"ratingKey"`       // Plex library entry, for deep links
	Movie     bool   `json:"movie,omitempty"` // from a film library: its TMDB id names a film
}

// plexGuidIndex folds every Plex show/movie title to the tvdb/tmdb id Plex
// assigned it, cached for an hour on the shared cache table. This is the bridge
// that lets an AniList-only series gain its TVDB/TMDB identity: Plex is the one
// place that carries all three ids for the same show. It waits for a build when
// there is no copy at all, so it belongs to background work; a request path
// uses plexGuidIndexNoWait. The map is shared: read it, never write to it.
func (s *Server) plexGuidIndex() map[string]plexGuid {
	return s.plexGuids.get(s, plexGuidKey, true, s.buildPlexGuidIndex)
}

// plexGuidIndexNoWait is plexGuidIndex for a request: it never waits on Plex,
// it answers from the last copy (empty before the first build) and warms a
// missing one in the background.
func (s *Server) plexGuidIndexNoWait() map[string]plexGuid {
	return s.plexGuids.get(s, plexGuidKey, false, s.buildPlexGuidIndex)
}

// v3: movie flag; v4: tvdbKey entries; v5: films under filmKey. A key bump
// skips stale cached blobs
const plexGuidKey = "plex:guididx:v5"

func (s *Server) buildPlexGuidIndex() (map[string]plexGuid, bool) {
	idx := map[string]plexGuid{}
	c := s.plexClient()
	if c == nil {
		return idx, false
	}
	secs, err := c.Sections()
	if err != nil {
		return idx, false
	}
	failed := false
	for _, sec := range secs {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			failed = true
			continue
		}
		for _, sh := range shows {
			// an IMDb id alone still leads to TVDB (remote id lookup)
			if sh.TVDBID == 0 && sh.TMDBID == 0 && sh.IMDBID == 0 {
				continue
			}
			g := plexGuid{TVDB: sh.TVDBID, TMDB: sh.TMDBID, IMDB: sh.IMDBID, Year: sh.Year, RatingKey: sh.RatingKey,
				Movie: sec.Type == "movie"}
			// a film and a series of one title ("Fargo") are different
			// entries with unrelated ids: each kind keeps its own title key,
			// or the library read last would answer for both
			for _, t := range []string{sh.Title, sh.OriginalTitle} {
				if k := match.FoldKey(t); k != "" {
					if g.Movie {
						k = filmKey(k)
					}
					idx[k] = g
				}
			}
			// two shows of one title ("Doctor Who" 2005 and 2023) share the
			// title key; the id keeps each of them findable
			if g.TVDB != 0 && !g.Movie {
				idx[tvdbKey(g.TVDB)] = g
			}
		}
	}
	// one library unreadable is a failure too: cached as complete, the shows it
	// holds would read as "not in Plex" for an hour and the reconcile pass would
	// mark their folders as done for good
	return idx, !failed
}

// tvdbKey files a Plex show under its TVDB id in plexGuidIndex. A folded title
// carries no colon, so the two kinds of key never meet.
func tvdbKey(id int) string { return "tvdb:" + strconv.Itoa(id) }

// filmKey files a Plex film under its folded title in plexGuidIndex; the bare
// folded title belongs to the series.
func filmKey(fold string) string { return "movie:" + fold }

// guidTitleKey is the guid index key of a folder's title for the kind of
// entry its match source names.
func guidTitleKey(folder, source string) string {
	k := match.FoldKey(match.GuessTitle(path.Base(folder)))
	if k != "" && (source == "tmdb:movie" || source == tvdbMovieSource) {
		return filmKey(k)
	}
	return k
}

// plexByTVDB is the Plex show holding one of the TVDB ids a series already
// carries: the same show by id, whatever its title or year in Plex.
func (s *Server) plexByTVDB(idx map[string]plexGuid, seriesID int64) (plexGuid, bool) {
	rows, err := s.DB.Query(`SELECT media_id FROM series_provider WHERE series_id = ? AND source = 'tvdb'`, seriesID)
	if err != nil {
		return plexGuid{}, false
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		if rows.Scan(&id) == nil {
			if g, ok := idx[tvdbKey(id)]; ok {
				return g, true
			}
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("plex tvdb lookup", "series", seriesID, "err", err)
	}
	return plexGuid{}, false
}

// reconcilePlex enriches series bundles with Plex's authoritative provider ids.
// For every matched folder that maps to a Plex show, it attaches that show's
// tvdb/tmdb id to the folder's series - so a show recognised only via AniList
// gains its TVDB/TMDB identity and folds together with any tvdb/tmdb match of
// the same show. Plex is trusted as ground truth here; INSERT OR IGNORE keeps an
// id that already belongs to another series untouched (no cross-series steal).
//
// Runs from the sweep, off the cached Plex index, so it costs no per-match Plex
// requests. budget caps folders touched per run.
func (s *Server) reconcilePlex(budget int) {
	idx := s.plexGuidIndex()
	if len(idx) == 0 {
		return
	}
	// Every matched folder is a candidate, not only those whose series has no
	// provider id yet. A series can already carry a tvdb id and still be missing
	// the one Plex knows: Fribb maps the 2012 JoJo season onto tvdb 83950 while
	// Plex calls the show 262954 - both real entries for the same show. Skipping
	// on "has any tvdb" is what kept those two apart. INSERT OR IGNORE below
	// makes a repeat pass free, so the only cost is the title lookup.
	rows, err := s.DB.Query(`SELECT DISTINCT cm.server_id, cm.folder, cm.source, sp.series_id
		FROM catalog_matches cm
		JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
		WHERE cm.media_id != 0
		  AND NOT EXISTS (SELECT 1 FROM plex_reconciled r WHERE r.server_id = cm.server_id AND r.folder = cm.folder)
		LIMIT ?`, budget)
	if err != nil {
		return
	}
	defer rows.Close()
	type hit struct {
		serverID int64
		folder   string
		source   string
		seriesID int64
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if rows.Scan(&h.serverID, &h.folder, &h.source, &h.seriesID) == nil {
			hits = append(hits, h)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("plex reconcile: matched folders", "err", err)
		return
	}

	enriched := 0
	for _, h := range hits {
		// the TVDB id the series already has beats its title: Plex may call
		// the show something else ("Little Britain in the USA"), or hold two
		// of the same name
		g, byID := s.plexByTVDB(idx, h.seriesID)
		ok := byID
		if !ok {
			g, ok = idx[guidTitleKey(h.folder, h.source)]
		}
		switch {
		case byID:
		case ok:
			if fy := folderYearOf(path.Base(h.folder)); fy != 0 && g.Year != 0 && absInt(fy-g.Year) > 1 {
				continue // same folded title, different show (remake vs original)
			}
		default:
			// the folder title folds to nothing Plex knows - but the series it is
			// matched to may already carry an id Plex publishes for its own shows.
			// That is the same identity from the other end, and it needs no title.
			showKey, _, _ := s.folderUnit(h.serverID, h.folder)
			g, ok = guidForShowKey(idx, showKey)
		}
		if !ok {
			_, _ = s.DB.Exec(`INSERT OR REPLACE INTO plex_reconciled (server_id, folder, checked_at) VALUES (?, ?, datetime('now'))`, h.serverID, h.folder) // a lost marker only means one more retry next sweep
			continue
		}
		s.attachPlexIdentity(h.seriesID, g, false)
		// remember the folder either way: a folder whose title does not resolve
		// must not be retried on every sweep, and one that did is done
		_, _ = s.DB.Exec(`INSERT OR REPLACE INTO plex_reconciled (server_id, folder, checked_at) VALUES (?, ?, datetime('now'))`, h.serverID, h.folder) // a lost marker only means one more retry next sweep
		if g.TVDB != 0 || g.TMDB != 0 || g.IMDB != 0 || g.RatingKey != "" {
			enriched++
			// series gained its cross-provider ids from Plex ground truth
			slog.Debug("plex reconcile enrich", "seriesId", h.seriesID,
				"tvdb", g.TVDB, "tmdb", g.TMDB, "imdb", g.IMDB)
		}
	}
	if enriched > 0 {
		slog.Info("plex reconcile", "enriched", enriched, "candidates", len(hits))
	}
}
