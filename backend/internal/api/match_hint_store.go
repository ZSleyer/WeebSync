package api

import (
	"database/sql"
	"errors"
	"log/slog"
)

// matchHint is TVDB's or TMDB's candidate for a folder AniList could not match: a
// suggestion the user confirms through the ordinary manual match (PUT
// catalog/match with this source and id) or drops. It is stored apart from
// the matches (see migration 097), so nothing that counts matches sees it.
type matchHint struct {
	Source  string `json:"source" enums:"tmdb:tv,tmdb:movie,tvdb,tvdb:movie"`
	MediaID int    `json:"mediaId"`
	Title   string `json:"title"`
	Year    int    `json:"year,omitempty"`
}

// hintFor is the hint stored for a folder, nil when there is none (or the
// user dropped it).
func (s *Server) hintFor(serverID int64, folder string) *matchHint {
	var h matchHint
	err := s.DB.QueryRow(`SELECT source, media_id, title, year FROM match_hints
		WHERE server_id = ? AND folder = ? AND state = 'hint'`, serverID, folder).Scan(&h.Source, &h.MediaID, &h.Title, &h.Year)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("match hint not read", "server", serverID, "folder", logSafe(folder), "err", err)
		}
		return nil
	}
	return &h
}

// hasManualMatch reports whether the user set the folder's match (or its
// "no match") by hand. A read that fails counts as yes: an automatic pass
// must not overwrite what it cannot tell is the user's.
func (s *Server) hasManualMatch(serverID int64, folder string) bool {
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE server_id = ? AND folder = ? AND manual = 1`,
		serverID, folder).Scan(&n); err != nil {
		slog.Warn("manual match not read", "server", serverID, "folder", logSafe(folder), "err", err)
		return true
	}
	return n > 0
}

// clearHint drops a folder's hint row, whatever its state: the folder has a
// match now, or the user unmatched it by hand.
func (s *Server) clearHint(serverID int64, folder string) {
	if _, err := s.DB.Exec(`DELETE FROM match_hints WHERE server_id = ? AND folder = ?`, serverID, folder); err != nil {
		slog.Warn("match hint not cleared", "server", serverID, "folder", logSafe(folder), "err", err)
	}
}
