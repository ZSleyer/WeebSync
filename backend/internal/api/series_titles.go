package api

import (
	"context"
	"strings"
	"time"
)

// Multi-locale titles: every available title translation of a bundled series,
// from every linked provider, stored in series_titles. Filled incrementally by
// the sweep (refreshSeriesTitles); read by seriesLocalTitle for display.

// titlesRefresh is how often a series' stored translations are re-fetched.
const titlesRefresh = 30 * 24 * time.Hour

// titlesBudget bounds series handled per sweep tick (each costs up to one
// TMDB + one TVDB call; AniList titles come from the local media cache).
const titlesBudget = 20

// storeSeriesTitle upserts one translation row; empty titles are dropped.
func (s *Server) storeSeriesTitle(seriesID int64, source, locale, title string) {
	locale = strings.ToLower(strings.TrimSpace(locale))
	title = strings.TrimSpace(title)
	if locale == "" || title == "" {
		return
	}
	s.DB.Exec(`INSERT INTO series_titles (series_id, source, locale, title) VALUES (?, ?, ?, ?)
		ON CONFLICT(series_id, source, locale) DO UPDATE SET title = excluded.title`,
		seriesID, source, locale, title)
}

// refreshSeriesTitles fetches all available title translations for series that
// were never fetched (new bundles) or are stale. Per series it walks the
// provider links: AniList titles come from the cached media (romaji='x-jat',
// english='en', native='ja'), TMDB and TVDB deliver their full translation
// sets in one call each. Best effort - a provider error just leaves that
// source's rows as they are; the stamp is still set so one broken series
// cannot starve the queue.
func (s *Server) refreshSeriesTitles(ctx context.Context, budget int) {
	cutoff := time.Now().UTC().Add(-titlesRefresh).Format(time.RFC3339)
	rows, err := s.DB.Query(`SELECT id FROM series
		WHERE titles_fetched_at = '' OR titles_fetched_at < ?
		ORDER BY titles_fetched_at LIMIT ?`, cutoff, budget)
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
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		s.fetchSeriesTitles(ctx, id)
		s.DB.Exec(`UPDATE series SET titles_fetched_at = ? WHERE id = ?`,
			time.Now().UTC().Format(time.RFC3339), id)
	}
}

// fetchSeriesTitles pulls every provider's translations for one series.
func (s *Server) fetchSeriesTitles(ctx context.Context, seriesID int64) {
	rows, err := s.DB.Query(`SELECT source, media_id FROM series_provider WHERE series_id = ?`, seriesID)
	if err != nil {
		return
	}
	var refs []providerRef
	for rows.Next() {
		var r providerRef
		if rows.Scan(&r.Source, &r.MediaID) == nil {
			refs = append(refs, r)
		}
	}
	rows.Close()
	for _, r := range refs {
		switch {
		case r.Source == "anilist":
			// no API call: the cached media already carries all three titles
			if m, _ := s.sourceMedia(r.Source, r.MediaID); m != nil {
				s.storeSeriesTitle(seriesID, "anilist", "x-jat", m.Title.Romaji)
				s.storeSeriesTitle(seriesID, "anilist", "en", m.Title.English)
				s.storeSeriesTitle(seriesID, "anilist", "ja", m.Title.Native)
			}
		case strings.HasPrefix(r.Source, "tmdb:"):
			if s.Tmdb == nil || !s.Tmdb.Enabled() {
				continue
			}
			kind := strings.TrimPrefix(r.Source, "tmdb:")
			if tr, err := s.Tmdb.Translations(ctx, kind, r.MediaID); err == nil {
				for loc, title := range tr {
					s.storeSeriesTitle(seriesID, "tmdb", loc, title)
				}
			}
		case r.Source == "tvdb":
			if s.Tvdb == nil || !s.Tvdb.Enabled() {
				continue
			}
			if tr, err := s.Tvdb.NameTranslations(ctx, r.MediaID); err == nil {
				for loc, title := range tr {
					s.storeSeriesTitle(seriesID, "tvdb", loc, title)
				}
			}
		}
	}
}

// titleLocaleChain is the display preference: German, English, Romaji.
var titleLocaleChain = []string{"de", "en", "x-jat"}

// titleSourceRank prefers curated providers over AniList on locale ties.
func titleSourceRank(source string) int {
	switch source {
	case "tvdb":
		return 0
	case "tmdb":
		return 1
	default:
		return 2
	}
}

// seriesLocalTitle resolves the stored display title of a series along the
// locale chain (de → en → x-jat); "" when nothing is stored yet. On a locale
// tie the curated providers (TVDB/TMDB) win over AniList.
func (s *Server) seriesLocalTitle(seriesID int64) string {
	if seriesID == 0 {
		return ""
	}
	rows, err := s.DB.Query(`SELECT source, locale, title FROM series_titles WHERE series_id = ?
		AND locale IN ('de', 'en', 'x-jat')`, seriesID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	best, bestRank := "", 1<<30
	for rows.Next() {
		var source, locale, title string
		if rows.Scan(&source, &locale, &title) != nil {
			continue
		}
		for i, want := range titleLocaleChain {
			if locale == want {
				if rank := i*10 + titleSourceRank(source); rank < bestRank {
					best, bestRank = title, rank
				}
				break
			}
		}
	}
	return best
}
