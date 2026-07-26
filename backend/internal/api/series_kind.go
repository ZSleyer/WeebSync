package api

import (
	"log/slog"
)

// Series kinds. Not the same question as film or series - that is is_movie on
// the unit. This one is about where the thing comes from.
const (
	kindAnime = "anime"
	kindLive  = "live_action"
)

// deriveSeriesKind decides what a series is from the providers that recognise it
// plus its metadata. Order matters:
//
//  1. AniList lists it, or the Fribb anime mapping knows one of its ids: anime.
//     Both catalogue anime and nothing else, so their word is enough.
//  2. Everything else: live action. Western animation is deliberately not a
//     kind of its own - categorize splits that off by genre, and it says
//     nothing about where the title comes from.
//
// A tvdb or tmdb id on its own decides nothing any more. It used to, back when
// such an id could only reach a series through the anime mapping; now the Plex
// bridge attaches one to every show it recognises, and reading it as an anime
// signal would file live action under anime.
//
// Returns "" when a series has no providers at all, so the caller leaves the
// row alone and tries again later.
func deriveSeriesKind(refs []providerRef, fribb bool) string {
	if len(refs) == 0 {
		return ""
	}
	if fribb {
		return kindAnime
	}
	for _, r := range refs {
		if r.Source == "anilist" {
			return kindAnime
		}
	}
	return kindLive
}

// refreshSeriesKinds fills in the kind of series that do not have one, a budget
// at a time from the sweep. Cheap: everything it reads is already cached.
func (s *Server) refreshSeriesKinds(budget int) {
	rows, err := s.DB.Query(`SELECT id FROM series WHERE kind = '' LIMIT ?`, budget)
	if err != nil {
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if len(ids) == 0 {
		return
	}
	_, bySeries := s.seriesProviderMaps()
	decided := 0
	for _, id := range ids {
		refs := bySeries[id]
		kind := deriveSeriesKind(refs, s.seriesInFribb(refs))
		if kind == "" {
			continue
		}
		s.DB.Exec(`UPDATE series SET kind = ? WHERE id = ?`, kind, id)
		decided++
	}
	if decided > 0 {
		slog.Info("series kinds decided", "count", decided, "candidates", len(ids))
	}
}

// seriesInFribb reports whether the anime mapping knows any of these ids. The
// table is keyed by AniList id but indexed by tvdb and tmdb as well (migration
// 037), so a show matched only through TMDB is still recognised as anime if the
// mapping carries it. That is the one place a non-AniList id may decide.
func (s *Server) seriesInFribb(refs []providerRef) bool {
	for _, r := range refs {
		var n int
		switch r.Source {
		case "anilist":
			if _, ok := s.animeIDs(r.MediaID); ok {
				return true
			}
		case "tvdb":
			s.DB.QueryRow(`SELECT 1 FROM anime_ids WHERE tvdb_id = ? LIMIT 1`, r.MediaID).Scan(&n)
		case "tmdb:tv", "tmdb:movie":
			s.DB.QueryRow(`SELECT 1 FROM anime_ids WHERE tmdb_id = ? LIMIT 1`, r.MediaID).Scan(&n)
		}
		if n == 1 {
			return true
		}
	}
	return false
}

// seriesKinds reads the decided kind of many series at once, for the builders
// that categorise a whole list.
func (s *Server) seriesKinds() map[int64]string {
	out := map[int64]string{}
	rows, err := s.DB.Query(`SELECT id, kind FROM series WHERE kind != ''`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var k string
		if rows.Scan(&id, &k) == nil {
			out[id] = k
		}
	}
	return out
}

// seriesKindOf reads one series' decided kind, "" when undecided or unknown.
func (s *Server) seriesKindOf(seriesID int64) string {
	if seriesID == 0 {
		return ""
	}
	var k string
	s.DB.QueryRow(`SELECT kind FROM series WHERE id = ?`, seriesID).Scan(&k)
	return k
}
