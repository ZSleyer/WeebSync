package api

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"strconv"
	"strings"
	"time"

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
	idx := s.plexGuidIndexNoWait()
	if len(idx) == 0 {
		return 0, false // no Plex configured / nothing indexed
	}
	base := path.Base(folder)
	g, ok := idx[guidTitleKey(folder, itemSource)]
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
	case "tvdb", tvdbMovieSource: // Plex keys a film by TVDB's film id
		movie := itemSource == tvdbMovieSource
		if g.Movie != movie {
			return 0, false // a film of the same name is not this show, nor the reverse
		}
		if g.TVDB != 0 {
			s.logLocalIDMatch(folder, "tvdb-direct", g.TVDB)
			return g.TVDB, true
		}
		if id := s.tvdbFromRemote(g, movie); id != 0 {
			s.logLocalIDMatch(folder, "tvdb-remote", id)
			return id, true
		}
	case "tmdb:tv", "tmdb:movie":
		// one TMDB number names a series and an unrelated film alike
		if g.Movie != (itemSource == "tmdb:movie") {
			return 0, false
		}
		if g.TMDB != 0 {
			s.logLocalIDMatch(folder, "tmdb-direct", g.TMDB)
			return g.TMDB, true
		}
	case "anilist":
		if g.Movie {
			// both lookups read the ids as a series' (tvdb, tmdb:tv): a
			// film's numbers name something else there
			return 0, false
		}
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

// tvdbFromRemote translates the IMDb or TMDB id Plex holds for a title into
// TVDB's, for a library whose agent carries no TVDB id (films nearly always,
// series under the TMDB agent). IMDb first: its ids are unique, where a TMDB
// number names a series and an unrelated film alike. 0 when TVDB knows none.
func (s *Server) tvdbFromRemote(g plexGuid, movie bool) int {
	if s.Tvdb == nil || !s.Tvdb.Enabled() {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var ids []string
	if g.IMDB != 0 {
		ids = append(ids, fmt.Sprintf("tt%07d", g.IMDB))
	}
	if g.TMDB != 0 {
		ids = append(ids, strconv.Itoa(g.TMDB))
	}
	for _, rid := range ids {
		series, film, err := s.Tvdb.RemoteID(ctx, rid)
		if err != nil {
			return 0
		}
		if movie && film != 0 {
			return film
		}
		if !movie && series != 0 {
			return series
		}
	}
	return 0
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
		if rows.Scan(&id) != nil {
			return 0, false
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		return 0, false // a partial read can make an ambiguous match look unique
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
			if rows.Scan(&r.id, &r.season) != nil {
				return 0, false
			}
			all = append(all, r)
		}
		if rows.Err() != nil {
			return 0, false
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
