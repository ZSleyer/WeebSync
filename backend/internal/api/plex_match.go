package api

import (
	"log/slog"
	"path"
	"strings"

	"github.com/ch4d1/weebsync/internal/match"
)

// matchLocalByPlexID is the id shortcut for LOCAL folders (server 0): instead of
// an AniList title search, use Plex's authoritative tvdb/tmdb guid for the show
// to adopt an already-known match. For a tvdb/tmdb scope the Plex id IS the
// match; for the anime (AniList) default it resolves back to an AniList media id
// via an existing series bundle (route "series") or the Fribb dataset (route
// "fribb"). Returns ok=false when nothing resolves unambiguously - the caller
// then falls back to the normal title search, so this never guesses.
func (s *Server) matchLocalByPlexID(folder, itemSource string) (int, bool) {
	idx := s.plexGuidIndex()
	if len(idx) == 0 {
		return 0, false // no Plex configured / nothing indexed
	}
	base := path.Base(folder)
	g, ok := idx[match.FoldKey(match.GuessTitle(base))]
	if !ok {
		return 0, false
	}
	// same year gate as reconcilePlex: a folded title match with a different
	// year is a remake, not this show
	if fy := folderYearOf(base); fy != 0 && g.Year != 0 && absInt(fy-g.Year) > 1 {
		return 0, false
	}
	season := match.ParseName(base, match.GuessTitle(base), "").Season
	if season == 0 {
		season = 1
	}

	switch itemSource {
	case "tvdb":
		if g.TVDB != 0 {
			s.logLocalIDMatch(folder, "tvdb-direct", g.TVDB)
			return g.TVDB, true
		}
	case "tmdb:tv", "tmdb:movie":
		if g.TMDB != 0 {
			s.logLocalIDMatch(folder, "tmdb-direct", g.TMDB)
			return g.TMDB, true
		}
	case "anilist":
		if id, ok := s.anilistFromSeries(g.TVDB, g.TMDB, season); ok {
			s.logLocalIDMatch(folder, "series", id)
			return id, true
		}
		if id, ok := s.anilistFromAnimeIDs(g.TVDB, g.TMDB, season); ok {
			s.logLocalIDMatch(folder, "fribb", id)
			return id, true
		}
	}
	return 0, false
}

func (s *Server) logLocalIDMatch(folder, route string, id int) {
	// strip CR/LF from the folder so it can't forge log lines
	f := strings.ReplaceAll(strings.ReplaceAll(folder, "\n", ""), "\r", "")
	slog.Debug("local matched via plex id", "folder", f, "route", route, "media", id)
}

// anilistFromSeries resolves a Plex tvdb/tmdb id to an AniList media id via an
// existing series bundle: the id already belongs to a series (populated by a
// prior match + reconcilePlex), so adopt that series' AniList match. When the
// series spans several seasons, the folder's season disambiguates via the Fribb
// tvdb_season; an unresolvable ambiguity returns false.
func (s *Server) anilistFromSeries(tvdb, tmdb, season int) (int, bool) {
	var seriesID int64
	for _, p := range []struct {
		src string
		id  int
	}{{"tvdb", tvdb}, {"tmdb:tv", tmdb}} {
		if p.id == 0 {
			continue
		}
		if err := s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`,
			p.src, p.id).Scan(&seriesID); err == nil && seriesID != 0 {
			break
		}
		seriesID = 0
	}
	if seriesID == 0 {
		return 0, false
	}
	rows, err := s.DB.Query(`SELECT media_id FROM series_provider WHERE series_id = ? AND source = 'anilist'`, seriesID)
	if err != nil {
		return 0, false
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		rows.Scan(&id)
		ids = append(ids, id)
	}
	if len(ids) == 1 {
		return ids[0], true
	}
	// several AniList seasons under one series: pick the one whose Fribb
	// tvdb_season matches this folder's season
	var matched []int
	for _, id := range ids {
		if a, ok := s.animeIDs(id); ok && a.tvdbSeason == season {
			matched = append(matched, id)
		}
	}
	if len(matched) == 1 {
		return matched[0], true
	}
	return 0, false
}

// anilistFromAnimeIDs is the Fribb reverse lookup (tvdb/tmdb -> anilist), for
// shows not yet in a series bundle. A tvdb id can map to several AniList
// season-ids; the folder's season disambiguates. tvdb is tried first (Plex
// ground truth), then tmdb (tv only). Returns false when still ambiguous.
func (s *Server) anilistFromAnimeIDs(tvdb, tmdb, season int) (int, bool) {
	pick := func(col, extra string, val int) (int, bool) {
		if val == 0 {
			return 0, false
		}
		// col/extra are constant literals, not user input
		rows, err := s.DB.Query(`SELECT anilist_id, tvdb_season FROM anime_ids WHERE `+col+` = ? `+extra, val)
		if err != nil {
			return 0, false
		}
		defer rows.Close()
		type row struct{ id, season int }
		var all []row
		for rows.Next() {
			var r row
			rows.Scan(&r.id, &r.season)
			all = append(all, r)
		}
		if len(all) == 1 {
			return all[0].id, true
		}
		var matched []int
		for _, r := range all {
			if r.season == season {
				matched = append(matched, r.id)
			}
		}
		if len(matched) == 1 {
			return matched[0], true
		}
		return 0, false
	}
	if id, ok := pick("tvdb_id", "", tvdb); ok {
		return id, true
	}
	return pick("tmdb_id", "AND tmdb_kind = 'tv'", tmdb)
}
