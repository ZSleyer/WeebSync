package api

import (
	"log/slog"
	"path"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/match"
)

// matchRules names the matcher's current rule set; bumping it re-checks every
// automatic match once against the rules, from the cache alone.
const matchRules = "2026-09-year"

// RevalidateMatches drops automatic matches the stricter matcher would not
// make today: a folder whose year is more than two years from the entry's
// ("One Piece (2022)" filed under the 1999 anime, "JoJo (2012)" under the
// 1993 OVA). Only the year is judged: titles are judged by the matcher's
// search, which sees synonyms and translations the cache does not, and a
// folder called "DanMachi" or "Frieren - Nach dem Ende der Reise" shares no
// word with its entry's romaji. Judged from cached media only; a folder
// without cached media keeps its match. What is dropped is queued for a
// fresh match. Runs once per rule set, at startup.
func (s *Server) RevalidateMatches() {
	if db.Setting(s.DB, "match_rules") == matchRules {
		return
	}
	rows, err := s.DB.Query(`SELECT server_id, folder, source, media_id FROM catalog_matches WHERE manual = 0 AND media_id != 0`)
	if err != nil {
		return
	}
	type row struct {
		serverID int64
		folder   string
		source   string
		mediaID  int
	}
	var all []row
	for rows.Next() {
		var r row
		if rows.Scan(&r.serverID, &r.folder, &r.source, &r.mediaID) == nil {
			all = append(all, r)
		}
	}
	rows.Close()
	dropped := 0
	for _, r := range all {
		m := s.cachedMedia(r.source, r.mediaID)
		if m == nil {
			continue
		}
		reason := matchStale(r.folder, *m)
		if reason == "" {
			continue
		}
		slog.Info("match dropped by the current rules", "folder", logSafe(r.folder), "source", r.source, "reason", reason,
			"media", r.mediaID, "title", logSafe(m.Title.Romaji), "english", logSafe(m.Title.English), "year", m.SeasonYear)
		s.persistMatch(r.serverID, r.folder, 0, false, r.source)
		s.queueScopedMatch(r.serverID, r.folder, path.Base(r.folder), s.scopeFor(r.serverID, path.Dir(r.folder)), true)
		dropped++
	}
	if dropped > 0 {
		s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`)
	}
	slog.Info("matches revalidated", "checked", len(all), "dropped", dropped)
	db.SetSetting(s.DB, "match_rules", matchRules)
}

// matchStale applies the rules to one folder/media pair and names the rule
// that fails, "" when the match stands.
func matchStale(folder string, m anilist.Media) string {
	base := path.Base(folder)
	info := match.ParseName(base, GuessTitle(base), GuessAltTitle(base))
	if info.Year != 0 && m.SeasonYear != 0 && absInt(m.SeasonYear-info.Year) > 2 {
		return "year"
	}
	return ""
}

// cachedMedia reads a match's media from the cache without queueing a fetch.
func (s *Server) cachedMedia(source string, id int) *anilist.Media {
	switch {
	case source == "anilist":
		m, _ := s.Anilist.CachedMedia(id)
		return m
	case strings.HasPrefix(source, "tmdb:") && s.Tmdb != nil:
		m, _ := s.Tmdb.CachedMedia(strings.TrimPrefix(source, "tmdb:"), id)
		return m
	case source == "tvdb" && s.Tvdb != nil:
		m, _ := s.Tvdb.CachedMedia(id)
		return m
	}
	return nil
}
