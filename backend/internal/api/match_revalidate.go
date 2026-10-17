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
const matchRules = "2026-10-live-no-year"

// RevalidateMatches drops automatic matches the stricter matcher would not
// make today: a folder whose year is more than two years from the entry's
// ("One Piece (2022)" filed under the 1999 anime, "JoJo (2012)" under the
// 1993 OVA), or a TVDB/TMDB entry without a year for a folder with one. Only
// the year is judged: titles are judged by the matcher's
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
	defer rows.Close()
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
	if rows.Err() != nil {
		return // a partial pass must not stamp the rule set as applied
	}
	dropped, failed := 0, 0
	for _, r := range all {
		m := s.cachedMedia(r.source, r.mediaID)
		if m == nil {
			continue
		}
		reason := matchStale(r.folder, r.source, *m)
		if reason == "" {
			continue
		}
		slog.Info("match dropped by the current rules", "folder", logSafe(r.folder), "source", r.source, "reason", reason,
			"media", r.mediaID, "title", logSafe(m.Title.Romaji), "english", logSafe(m.Title.English), "year", m.SeasonYear)
		if err := s.persistMatch(r.serverID, r.folder, 0, false, r.source); err != nil {
			// still filed under the wrong show: leave the rule set unstamped so
			// the next start judges it again
			failed++
			continue
		}
		// the index row carries the show key the old match gave it; without
		// this the folder keeps meeting the wrong show until its next crawl
		if _, err := s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = ? AND folder = ?`, r.serverID, r.folder); err != nil {
			slog.Warn("variants of a dropped match not cleared", "folder", logSafe(r.folder), "err", err)
		}
		// a local folder asks Plex first (its guid names the 2012 JoJo, not a
		// title search); force would skip that
		force := r.serverID != localServerID
		scope := s.scopeFor(r.serverID, path.Dir(r.folder))
		if scope == "" && r.source != "anilist" {
			// no mark above (a watch matched in its library's source): search
			// where the match came from, not on AniList
			scope = strings.TrimPrefix(r.source, "tmdb:")
		}
		if r.source == mangaSource {
			scope = "manga" // a manga stays a manga; its tree often carries no mark
		}
		s.queueScopedMatch(r.serverID, r.folder, path.Base(r.folder), scope, force)
		dropped++
	}
	if dropped > 0 {
		s.staleSuggestions()
	}
	slog.Info("matches revalidated", "checked", len(all), "dropped", dropped, "failed", failed)
	if failed > 0 {
		return
	}
	if err := db.SetSetting(s.DB, "match_rules", matchRules); err != nil {
		slog.Warn("match rule set not recorded", "err", err)
	}
}

// matchStale applies the rules to one folder/media pair and names the rule
// that fails, "" when the match stands.
func matchStale(folder, source string, m anilist.Media) string {
	base := path.Base(folder)
	info := match.ParseName(base, GuessTitle(base), GuessAltTitle(base))
	if info.Year != 0 && m.SeasonYear != 0 && absInt(m.SeasonYear-info.Year) > 2 {
		return "year"
	}
	// pickLive takes no entry without a year for a folder with one; the first
	// TVDB/TMDB matcher took the top hit, often such a stub ("Bet (2025)"
	// filed under "Best Bet")
	if info.Year != 0 && m.SeasonYear == 0 && source != "anilist" && source != mangaSource {
		return "no-year"
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
	case source == tvdbMovieSource && s.Tvdb != nil:
		m, _ := s.Tvdb.CachedMovie(id)
		return m
	}
	return nil
}

// watchMatchRules names how watch folders are matched; bumping it searches every
// watch's stored miss (media_id 0) once more, and every match from another
// source than the folder's scope, manual or not.
const watchMatchRules = "2026-10-source-follows-scope"

// BackfillWatchMatches queues a match for every watch folder that has none.
// Watches older than ensureWatchMatch never got one, and a queued search that
// was dropped (full queue, timeout, search error) leaves no row that a catalog
// poll would ever revisit for a folder outside every catalog view. Stored
// misses and matches from a foreign source are retried once per rule set. Run after the Plex roots are known:
// the library scope decides where a folder is searched.
//
// ponytail: a dropped search waits for the next start; re-queue from the watch
// check if that proves too slow. Returns how many folders were queued.
func (s *Server) BackfillWatchMatches() int {
	retryMisses := db.Setting(s.DB, "watch_match_rules") != watchMatchRules
	rows, err := s.DB.Query(`SELECT w.server_id, w.remote_path, w.local_path, m.media_id IS NULL
		FROM watches w LEFT JOIN catalog_matches m ON m.server_id = w.server_id AND m.folder = w.remote_path`)
	if err != nil {
		return 0
	}
	defer rows.Close()
	type watchFolder struct {
		serverID      int64
		remote, local string
		missing       bool
	}
	var all []watchFolder
	for rows.Next() {
		var w watchFolder
		if rows.Scan(&w.serverID, &w.remote, &w.local, &w.missing) == nil {
			all = append(all, w)
		}
	}
	if rows.Err() != nil {
		return 0 // a partial pass must not stamp the rule set as applied
	}
	queued := 0
	for _, w := range all {
		if (w.missing || retryMisses) && s.matchWatch(w.serverID, w.remote, w.local, retryMisses) {
			queued++
		}
	}
	slog.Info("watch matches backfilled", "watches", len(all), "queued", queued)
	// a Plex that did not answer yet leaves no library scopes: retry the misses
	// on the next start rather than settle them on AniList
	if s.plexClient() == nil || db.Setting(s.DB, "plex_lib_scopes") != "" {
		if err := db.SetSetting(s.DB, "watch_match_rules", watchMatchRules); err != nil {
			slog.Warn("watch match rule set not recorded", "err", err)
		}
	}
	return queued
}
