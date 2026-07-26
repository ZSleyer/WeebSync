package api

import (
	"log/slog"
	"strings"

	"github.com/ch4d1/weebsync/internal/match"
)

// showRef is the show-level identity of an AniList work: the provider id that
// spans the whole show, and which season of it this work is.
type showRef struct {
	Source  string
	MediaID int
	Season  int
}

// showIdentity resolves an AniList id to the show it is a season of, through
// the Fribb mapping. Only show-level providers count: one TVDB id (or one TMDB
// tv id) spans every season, which is the level the rest of the app already
// groups by - folderUnit builds the same "tvdb:262954" key for every season of
// JoJo.
//
// A film gets no show. "Heroes:Rising" carries the My Hero Academia tvdb id
// because that is where the dataset files it, but it is an entry of its own,
// not a season of the show; season 0 plus a TMDB movie id is how the mapping
// says so.
func (s *Server) showIdentity(anilistID int) (showRef, bool) {
	a, ok := s.animeIDs(anilistID)
	if !ok {
		return showRef{}, false
	}
	if a.tmdbKind == "movie" && a.tvdbSeason == 0 {
		return showRef{}, false
	}
	switch {
	case a.tvdbID != 0:
		return showRef{Source: "tvdb", MediaID: a.tvdbID, Season: a.tvdbSeason}, true
	case a.tmdbID != 0 && a.tmdbKind == "tv":
		return showRef{Source: "tmdb:tv", MediaID: a.tmdbID, Season: a.tmdbSeason}, true
	}
	return showRef{}, false
}

// seriesByProvider returns the series a provider id hangs on, 0 for none.
func (s *Server) seriesByProvider(source string, mediaID int) int64 {
	var id int64
	s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&id)
	return id
}

// claimShow hangs the show-level id on this series and records what the work
// called its season. The provider row is what makes the next cour of the same
// show find its way here instead of starting an entry of its own.
func (s *Server) claimShow(seriesID int64, ref showRef, title string, year int) {
	s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES (?, ?, ?)`,
		ref.Source, ref.MediaID, seriesID)
	if title == "" {
		return
	}
	// first namer wins: a season keeps the name of the work that is that
	// season, and a second work covering the same one does not overwrite it.
	s.DB.Exec(`INSERT OR IGNORE INTO series_seasons (series_id, season, title, source, year)
		VALUES (?, ?, ?, 'anilist', ?)`, seriesID, ref.Season, title, year)
}

// mergeSeries moves everything hanging on one series onto another and drops the
// empty shell. OR IGNORE on the moves: what the target already carries stays,
// the losing row is deleted with the series.
func (s *Server) mergeSeries(from, into int64) {
	if from == 0 || into == 0 || from == into {
		return
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	for _, q := range []string{
		`UPDATE OR IGNORE series_provider SET series_id = ? WHERE series_id = ?`,
		`UPDATE OR IGNORE series_titles SET series_id = ? WHERE series_id = ?`,
		`UPDATE OR IGNORE series_seasons SET series_id = ? WHERE series_id = ?`,
		`UPDATE catalog_variants SET series_id = ? WHERE series_id = ?`,
		// an ignore list entry names the series it hid; the show it merged
		// into is the same thing under a new id
		`UPDATE OR IGNORE suggestion_dismissals SET ref_key = 'series:' || ? WHERE ref_key = 'series:' || ?`,
	} {
		if _, err := tx.Exec(q, into, from); err != nil {
			return
		}
	}
	// what OR IGNORE left behind, plus the series itself. Explicit rather than
	// relying on ON DELETE CASCADE, which needs a pragma to fire at all.
	for _, q := range []string{
		`DELETE FROM series_provider WHERE series_id = ?`,
		`DELETE FROM series_titles WHERE series_id = ?`,
		`DELETE FROM series_seasons WHERE series_id = ?`,
		`DELETE FROM series WHERE id = ?`,
	} {
		if _, err := tx.Exec(q, from); err != nil {
			return
		}
	}
	if tx.Commit() == nil {
		slog.Info("series merged into show", "from", from, "into", into)
	}
}

// mergeShowSeries folds AniList works that are seasons of one show into a
// single entry, a budget at a time from the sweep. New matches take the same
// route through linkSeries; this is the pass over what was bundled before the
// show level existed.
func (s *Server) mergeShowSeries(budget int) {
	type cand struct {
		seriesID int64
		anilist  int
	}
	// candidates: an anilist work whose show id is not yet on its series. Once
	// claimShow writes that row the work stops coming back, so a show that is
	// already one entry costs nothing.
	rows, err := s.DB.Query(`SELECT sp.series_id, sp.media_id
		FROM series_provider sp
		JOIN anime_ids a ON a.anilist_id = sp.media_id
		WHERE sp.source = 'anilist'
		  AND NOT (a.tmdb_kind = 'movie' AND a.tvdb_season = 0)
		  AND (a.tvdb_id > 0 OR (a.tmdb_id > 0 AND a.tmdb_kind = 'tv'))
		  AND NOT EXISTS (
		      SELECT 1 FROM series_provider x WHERE x.series_id = sp.series_id
		        AND ((a.tvdb_id > 0 AND x.source = 'tvdb' AND x.media_id = a.tvdb_id)
		          OR (a.tvdb_id = 0 AND x.source = 'tmdb:tv' AND x.media_id = a.tmdb_id)))
		LIMIT ?`, budget)
	if err != nil {
		return
	}
	var cands []cand
	for rows.Next() {
		var c cand
		if rows.Scan(&c.seriesID, &c.anilist) == nil {
			cands = append(cands, c)
		}
	}
	rows.Close()

	merged, touched := 0, map[int64]bool{}
	for _, c := range cands {
		ref, ok := s.showIdentity(c.anilist)
		if !ok {
			continue
		}
		media, _ := s.sourceMedia("anilist", c.anilist)
		if media == nil {
			continue // metadata not cached yet; sourceMedia queued it, retry next sweep
		}
		seriesID := c.seriesID
		if owner := s.seriesByProvider(ref.Source, ref.MediaID); owner != 0 && owner != seriesID {
			s.mergeSeries(seriesID, owner)
			seriesID = owner
			merged++
		}
		s.claimShow(seriesID, ref, mediaTitle(media), media.SeasonYear)
		touched[seriesID] = true
	}
	for id := range touched {
		s.refreshShowTitle(id)
	}
	if merged > 0 {
		slog.Info("show series merged", "merged", merged, "candidates", len(cands))
	}
}

// refreshShowTitle names the show from the seasons it is made of, and dates it
// from the earliest of them. After a merge the entry may carry a season's name
// ("JoJo no Kimyou na Bouken: Stardust Crusaders" is season 2, not the show),
// so the shared prefix of the season titles decides where one exists.
//
// ponytail: named from AniList titles, not from TVDB/TMDB, which would need a
// fetch to say "JoJo's Bizarre Adventure". series_titles already carries the
// localized display title, so this one only has to be recognisable.
func (s *Server) refreshShowTitle(seriesID int64) {
	// season 0 is where the specials live ("Kishibe Rohan wa Ugokanai" under
	// JoJo); it shares nothing with the show's name and must not become it.
	rows, err := s.DB.Query(`SELECT season, title, year FROM series_seasons
		WHERE series_id = ? AND title != '' AND season > 0 ORDER BY season`, seriesID)
	if err != nil {
		return
	}
	var titles []string
	firstYear := 0
	for rows.Next() {
		var season, year int
		var title string
		if rows.Scan(&season, &title, &year) != nil {
			continue
		}
		titles = append(titles, title)
		if year != 0 && (firstYear == 0 || year < firstYear) {
			firstYear = year
		}
	}
	rows.Close()
	if len(titles) == 0 {
		return
	}
	name := titles[0]
	if len(titles) > 1 {
		if p := sharedTitlePrefix(titles); p != "" {
			name = p
		}
	}
	key := match.FoldKey(match.StripMarkers(name))
	if key == "" {
		return
	}
	if firstYear == 0 {
		s.DB.Exec(`UPDATE series SET key = ?, title = ? WHERE id = ?`, key, name, seriesID)
		return
	}
	s.DB.Exec(`UPDATE series SET key = ?, title = ?, year = ? WHERE id = ?`, key, name, firstYear, seriesID)
}

// sharedTitlePrefix returns the common opening of several season titles, cut
// back to a word boundary and stripped of trailing punctuation. "" when the
// titles share nothing usable - the Monogatari seasons all end in the same
// word rather than starting with it, and no prefix is better than a stub.
func sharedTitlePrefix(titles []string) string {
	p := titles[0]
	for _, t := range titles[1:] {
		n := 0
		for n < len(p) && n < len(t) && p[n] == t[n] {
			n++
		}
		p = p[:n]
		if p == "" {
			return ""
		}
	}
	// a prefix must not end mid-word: every longer title has to continue with
	// a separator, or "Naruto" would be cut out of "Narutaki". Cut back to the
	// previous boundary until that holds for all of them.
	for midWord(p, titles) {
		cut := strings.LastIndexAny(p, " :-_/([")
		if cut <= 0 {
			return ""
		}
		p = p[:cut]
	}
	p = strings.TrimRight(p, " :-_/([,.")
	if len([]rune(p)) < 3 {
		return ""
	}
	return p
}

// midWord reports whether any title continues the prefix without a separator.
func midWord(p string, titles []string) bool {
	for _, t := range titles {
		if len(t) > len(p) && !strings.ContainsRune(" :-_/([", rune(t[len(p)])) {
			return true
		}
	}
	return false
}
