package api

import (
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/rename"
)

// persistMatch stores a folder's provider match and keeps the derived tables in
// step: the canonical series bundle (series/series_provider) and the folder's
// quality variant. Every matcher writes through here so a match can never land
// without being bundled. media_id 0 (explicit no-match) only writes the row.
func (s *Server) persistMatch(serverID int64, folder string, mediaID int, manual bool, source string) {
	m := 0
	if manual {
		m = 1
	}
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, ?, ?)`,
		serverID, folder, mediaID, m, source)
	if mediaID == 0 {
		return
	}
	created, title := s.linkSeries(source, mediaID)
	s.refreshVariant(serverID, folder)
	// a brand-new series (first time this show is seen anywhere) is a
	// suggestion worth telling the server's owner about. Backfill calls
	// linkSeries directly, not persistMatch, so it never fires this. server 0
	// (local) has no owner row - skip.
	if created && !manual && serverID != 0 {
		var owner int64
		if s.DB.QueryRow(`SELECT user_id FROM servers WHERE id = ?`, serverID).Scan(&owner) == nil && owner != 0 {
			s.NotifyEvent(owner, "suggestion", tr(s.userLocale(owner), "notify.newSeries"), title, "/suggestions")
		}
	}
}

// linkSeries attaches a (source, media_id) provider hit to a canonical series,
// creating the series when none matches. The identity is the fold key of the
// base title (season markers stripped) so every season of a show, and any
// provider whose title folds equal, land in one series. The year gate keeps
// remakes apart ("Fruits Basket" 2001 vs 2019).
//
// ponytail: keying by StripMarkers+FoldKey bundles cross-server and any
// provider whose titles fold equal; it will NOT join AniList romaji to a TMDB
// english title that differs. The Plex-GUID reconcile pass (reconcilePlex) is
// the cross-provider join for shows that share a TVDB/TMDB id - upgrade here
// only if that proves insufficient.
// linkSeries returns (created, title): created is true only when a brand-new
// series row was inserted (not when the provider joined an existing series or
// was already bundled), so the caller can raise a "new series" notification.
func (s *Server) linkSeries(source string, mediaID int) (created bool, title string) {
	media, _ := s.sourceMedia(source, mediaID)
	if media == nil {
		return false, "" // metadata not cached yet; a later match/sweep links it
	}
	title = media.Title.Romaji
	if title == "" {
		title = media.Title.English
	}
	if title == "" {
		return false, ""
	}
	key := match.FoldKey(match.StripMarkers(title))
	if key == "" {
		return false, ""
	}
	year := media.SeasonYear

	s.seriesMu.Lock()
	defer s.seriesMu.Unlock()

	var have int
	if s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&have); have > 0 {
		return false, title // already bundled
	}

	seriesID := s.findSeries(key, year)
	if seriesID == 0 {
		res, err := s.DB.Exec(`INSERT INTO series (key, title, year) VALUES (?, ?, ?)`, key, title, year)
		if err != nil {
			return false, title
		}
		seriesID, _ = res.LastInsertId()
		created = true
	}
	s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES (?, ?, ?)`,
		source, mediaID, seriesID)
	return created, title
}

// findSeries returns the id of an existing series matching key under the year
// gate (year within 1, or either side unknown), or 0 for none. Caller holds
// seriesMu.
func (s *Server) findSeries(key string, year int) int64 {
	rows, err := s.DB.Query(`SELECT id, year FROM series WHERE key = ?`, key)
	if err != nil {
		return 0
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var sy int
		if rows.Scan(&id, &sy) != nil {
			continue
		}
		if d := year - sy; year == 0 || sy == 0 || (d >= -1 && d <= 1) {
			return id
		}
	}
	return 0
}

// FolderQuality is the resolution and language make-up of one physical folder,
// aggregated over its files (season subfolders included).
type FolderQuality struct {
	ResRank int      // max video height, 0 = unknown
	Dub     []string // canonical dub language codes, sorted
	Sub     []string // canonical sub language codes, sorted
}

// scanQuality reads a folder's quality from the remote index: the highest
// resolution and the union of dub/sub language codes across its files. Local
// folders (server 0) have no remote index, so they return empty for now;
// remote variants already cover the upgrade comparison.
//
// ponytail: local (server 0) quality left empty - add a local file walk here
// only if upgrades between two local copies ever matter.
func (s *Server) scanQuality(serverID int64, folder string) FolderQuality {
	q := FolderQuality{}
	if serverID == 0 {
		// local: no remote_index. Read the real quality from the files via
		// ffprobe (filenames often lack the tokens); fall back to parsing the
		// filenames when ffprobe is unavailable or finds nothing.
		if abs, err := s.safeLocal(folder); err == nil {
			if pq, ok := probeQuality(abs); ok {
				return pq
			}
			return localFilenameQuality(abs)
		}
		return q
	}
	rows, err := s.DB.Query(`SELECT name FROM remote_index
		WHERE server_id = ? AND (parent = ? OR parent LIKE ?||'/%')`,
		serverID, folder, folder)
	if err != nil {
		return q
	}
	defer rows.Close()
	dubSet, subSet := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var name string
		if rows.Scan(&name) != nil {
			continue
		}
		if r := rename.Resolution(name); r > q.ResRank {
			q.ResRank = r
		}
		dub, sub := rename.LangTags(name)
		for _, c := range rename.Codes(dub) {
			dubSet[canonCode(c)] = true
		}
		for _, c := range rename.Codes(sub) {
			subSet[canonCode(c)] = true
		}
	}
	q.Dub, q.Sub = keysSorted(dubSet), keysSorted(subSet)
	return q
}

// refreshVariant recomputes and stores a folder's quality variant along with the
// canonical unit (show_key, season, is_movie) it belongs to, so upgrade and
// incomplete comparisons can GROUP BY that unit across servers.
func (s *Server) refreshVariant(serverID int64, folder string) {
	q := s.scanQuality(serverID, folder)
	showKey, season, isMovie := s.folderUnit(serverID, folder)
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_variants
		(server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		serverID, folder, q.ResRank, strings.Join(q.Dub, ","), strings.Join(q.Sub, ","),
		time.Now().UTC().Format(time.RFC3339), showKey, season, boolInt(isMovie))
}

// folderUnit derives the canonical (show_key, season, is_movie) of a matched
// folder from its catalog_matches provider hit. The show_key is the shared
// cross-provider show identity so a local and a remote copy of the SAME season
// collide on it:
//   - anilist: the Fribb mapping gives the exact TVDB/TMDB id + season number
//     (authoritative, matches Plex's season index). Without a mapping, fall back
//     to the title fold key + a best-effort season from the media/folder name.
//   - tmdb:tv / tvdb: one id spans all seasons; the season is parsed from the
//     folder name (live-action folders carry "Season N").
//   - tmdb:movie: a movie, season 0.
func (s *Server) folderUnit(serverID int64, folder string) (showKey string, season int, isMovie bool) {
	var source string
	var mediaID int
	if s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&source, &mediaID); source == "" || mediaID == 0 {
		return "", 0, false
	}
	base := filepath.Base(folder)
	switch {
	case source == "anilist":
		media, _ := s.sourceMedia(source, mediaID)
		if a, ok := s.animeIDs(mediaID); ok {
			switch {
			case a.tvdbID != 0:
				return "tvdb:" + strconv.Itoa(a.tvdbID), unitSeason(a.tvdbSeason, media, base), false
			case a.tmdbID != 0 && a.tmdbKind == "movie":
				return "tmdb:" + strconv.Itoa(a.tmdbID), 0, true
			case a.tmdbID != 0:
				return "tmdb:" + strconv.Itoa(a.tmdbID), unitSeason(a.tmdbSeason, media, base), false
			case a.imdbID != "":
				return "imdb:" + a.imdbID, unitSeason(0, media, base), false
			}
		}
		// no Fribb mapping: best-effort fold key + season (won't line up with
		// Plex's tvdb key, so no false cross matches - just no suggestion)
		if media != nil {
			if media.Format == "MOVIE" {
				return "fold:" + match.FoldKey(match.StripMarkers(mediaTitle(media))), 0, true
			}
			return "fold:" + match.FoldKey(match.StripMarkers(mediaTitle(media))), unitSeason(0, media, base), false
		}
		return "", 0, false
	case source == "tmdb:movie":
		return "tmdb:" + strconv.Itoa(mediaID), 0, true
	case source == "tmdb:tv":
		return "tmdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	case source == "tvdb":
		return "tvdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	case source == "imdb":
		return "imdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	}
	return "", 0, false
}

// unitSeason resolves an anime folder's season: the Fribb season when known
// (authoritative), else AniList's SeasonOf, else the folder name, defaulting to
// 1 so a base anime entry lines up with Plex's season-1 index.
//
// ponytail: default-to-1 is a heuristic for the no-Fribb path; the Fribb season
// is the real key. A show whose Plex season index disagrees just won't match.
func unitSeason(fribbSeason int, media *anilist.Media, base string) int {
	if fribbSeason > 0 {
		return fribbSeason
	}
	if media != nil {
		if s := match.SeasonOf(*media); s > 0 {
			return s
		}
	}
	if s := match.ParseName(base, "", "").Season; s > 0 {
		return s
	}
	return 1
}

func mediaTitle(m *anilist.Media) string {
	if m.Title.Romaji != "" {
		return m.Title.Romaji
	}
	return m.Title.English
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
