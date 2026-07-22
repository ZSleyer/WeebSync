package api

import (
	"encoding/json"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

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
	RatingKey string `json:"ratingKey"` // Plex library entry, for deep links
}

// plexGuidIndex folds every Plex show/movie title to the tvdb/tmdb id Plex
// assigned it, cached for an hour on the shared cache table. This is the bridge
// that lets an AniList-only series gain its TVDB/TMDB identity: Plex is the one
// place that carries all three ids for the same show.
func (s *Server) plexGuidIndex() map[string]plexGuid {
	idx := map[string]plexGuid{}
	// v2: ratingKey added; a key bump skips stale cached blobs without the field
	if p, ok := s.cacheGet("plex:guididx:v2", time.Hour); ok {
		json.Unmarshal([]byte(p), &idx)
		return idx
	}
	c := s.plexClient()
	if c == nil {
		return idx
	}
	secs, err := c.Sections()
	if err != nil {
		return idx
	}
	for _, sec := range secs {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			if sh.TVDBID == 0 && sh.TMDBID == 0 {
				continue
			}
			g := plexGuid{TVDB: sh.TVDBID, TMDB: sh.TMDBID, IMDB: sh.IMDBID, Year: sh.Year, RatingKey: sh.RatingKey}
			for _, t := range []string{sh.Title, sh.OriginalTitle} {
				if k := match.FoldKey(t); k != "" {
					idx[k] = g
				}
			}
		}
	}
	if p, err := json.Marshal(idx); err == nil {
		s.cacheSet("plex:guididx:v2", string(p))
	}
	return idx
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
	// folders whose series has no tvdb AND no tmdb provider yet - those are the
	// ones a Plex id can still enrich
	rows, err := s.DB.Query(`SELECT DISTINCT cm.folder, sp.series_id
		FROM catalog_matches cm
		JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
		WHERE cm.media_id != 0
		  AND NOT EXISTS (SELECT 1 FROM series_provider x
		                  WHERE x.series_id = sp.series_id AND x.source = 'tvdb')
		LIMIT ?`, budget)
	if err != nil {
		return
	}
	type hit struct {
		folder   string
		seriesID int64
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if rows.Scan(&h.folder, &h.seriesID) == nil {
			hits = append(hits, h)
		}
	}
	rows.Close()

	for _, h := range hits {
		g, ok := idx[match.FoldKey(match.GuessTitle(path.Base(h.folder)))]
		if !ok {
			continue
		}
		if fy := folderYearOf(path.Base(h.folder)); fy != 0 && g.Year != 0 && absInt(fy-g.Year) > 1 {
			continue // same folded title, different show (remake vs original)
		}
		if g.TVDB != 0 {
			s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES ('tvdb', ?, ?)`,
				g.TVDB, h.seriesID)
		}
		if g.TMDB != 0 {
			s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES ('tmdb:tv', ?, ?)`,
				g.TMDB, h.seriesID)
		}
		// imdb id only comes from Plex; attach it in the same pass (used for the
		// suggestion imdb badge/link, and as an extra dedup axis)
		if g.IMDB != 0 {
			s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES ('imdb', ?, ?)`,
				g.IMDB, h.seriesID)
		}
	}
}
