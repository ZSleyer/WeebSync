package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// What is trending, for the TV launcher's discovery row. One global list for
// every device, assembled in the background from the AniList and TMDB
// charts and stored as a blob; a poll only reads it and adds what is
// personal (is it in the library, do I watch it). Same principle as the other
// TV routes: a request never makes a provider answer.

const (
	tvTrendingKey   = "tv:trending:v1"
	tvTrendingJob   = "tv:trending"
	tvTrendingTTL   = 8 * time.Hour    // a complete blob is rebuilt after this
	tvTrendingRetry = 30 * time.Minute // a blob a provider failed for is rebuilt sooner
	tvTrendingCap   = 60               // entries kept in the blob
	tvTrendingBuild = 10 * time.Minute // the build's time budget
	tvTrendingKinds = "|anime|tv|movie|all|"
)

// tvTrendingItem is one trending title.
type tvTrendingItem struct {
	Source    string `json:"source"` // anime | tv | movie
	AnilistID int    `json:"anilistId,omitempty"`
	TmdbID    int    `json:"tmdbId,omitempty"`
	TvdbID    int    `json:"tvdbId,omitempty"`
	// Title in German where TMDB has one, else the provider's title
	Title string `json:"title"`
	// Overview in German where there is one, else English
	Overview    string `json:"overview,omitempty"`
	Year        int    `json:"year,omitempty"`
	PosterURL   string `json:"posterUrl,omitempty"`
	BackdropURL string `json:"backdropUrl,omitempty"`
	InLibrary   bool   `json:"inLibrary"`               // the media server holds it
	PlexKey     string `json:"plexRatingKey,omitempty"` // its entry on the media server
	WatchID     int64  `json:"watchId,omitempty"`       // the caller's own watch on it
	Rank        int    `json:"rank"`                    // 1 = top of the interleaved list
}

// tvTrendingEntry is a blob row: the item plus the titles the library
// check compares against (not sent to devices).
type tvTrendingEntry struct {
	tvTrendingItem
	Titles []string `json:"titles,omitempty"`
}

type tvTrendingBlob struct {
	BuiltAt int64             `json:"builtAt"`
	Partial bool              `json:"partial,omitempty"` // a provider failed during the build
	Items   []tvTrendingEntry `json:"items"`
}

// tvTrendingBlob reads the stored blob and when it was written.
func (s *Server) tvTrendingBlob() (b tvTrendingBlob, fetched time.Time, ok bool) {
	var payload, at string
	if s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, tvTrendingKey).Scan(&payload, &at) != nil {
		return b, fetched, false
	}
	t, err := time.Parse(sqliteTime, at)
	if err != nil || json.Unmarshal([]byte(payload), &b) != nil {
		return tvTrendingBlob{}, time.Time{}, false
	}
	return b, t, true
}

// tvTrendingStale says whether the blob wants a rebuild.
func (s *Server) tvTrendingStale() bool {
	b, at, ok := s.tvTrendingBlob()
	if !ok {
		return true
	}
	ttl := tvTrendingTTL
	if b.Partial {
		ttl = tvTrendingRetry
	}
	return time.Since(at) > ttl
}

// warmTVTrending schedules a rebuild when the blob is missing or stale; the
// sweep calls it, and so does a poll that finds the blob stale.
func (s *Server) warmTVTrending() {
	if s.tvTrendingStale() {
		s.runJobFor(tvTrendingJob, tvTrendingBuild, s.buildTVTrending)
	}
}

// tmdbArtKind is the TMDB kind of an anime_ids row.
func tmdbArtKind(k string) string {
	if k == "movie" {
		return "movie"
	}
	return "tv"
}

// buildTVTrending assembles the global trending blob. The providers' own
// caches keep a rebuild cheap; a build every few hours is all it takes.
func (s *Server) buildTVTrending(ctx context.Context) {
	partial := false
	var anime, tv, movie []tvTrendingEntry
	seenTmdb := map[string]bool{} // "tv:123": a series is listed once, whichever chart brought it
	seenAni := map[int]bool{}

	if s.Anilist != nil {
		list, err := s.Anilist.Trending(ctx)
		if err != nil {
			partial = true
			slog.Warn("tv trending: AniList failed", "err", err)
		}
		for _, m := range list {
			if seenAni[m.ID] {
				continue
			}
			seenAni[m.ID] = true
			title := firstNonEmpty(m.Title.Preferred, m.Title.Romaji, m.Title.English)
			if title == "" {
				continue
			}
			e := tvTrendingEntry{tvTrendingItem: tvTrendingItem{Source: "anime", AnilistID: m.ID, Title: title}}
			e.Titles = []string{m.Title.Romaji, m.Title.English, m.Title.Native}
			e.Year = m.SeasonYear
			e.PosterURL = firstNonEmpty(m.CoverImage.ExtraLarge, m.CoverImage.Large)
			e.Overview = plainText(m.Description)
			if ids, ok := s.animeIDs(m.ID); ok {
				e.TvdbID = ids.tvdbID
				if ids.tmdbID != 0 {
					k := tmdbArtKind(ids.tmdbKind) + ":" + strconv.Itoa(ids.tmdbID)
					if seenTmdb[k] {
						continue // another cour of a series already listed
					}
					seenTmdb[k] = true
					e.TmdbID = ids.tmdbID
				}
			}
			anime = append(anime, e)
		}
	}

	if s.Tmdb.Enabled() {
		for _, kind := range []string{"tv", "movie"} {
			list, err := s.Tmdb.Trending(ctx, kind)
			if err != nil {
				partial = true
				slog.Warn("tv trending: TMDB failed", "kind", kind, "err", err)
				continue
			}
			for _, m := range list {
				k := kind + ":" + strconv.Itoa(m.ID)
				title := firstNonEmpty(m.Title.Romaji, m.Title.English)
				if seenTmdb[k] || title == "" {
					continue // already in as an anime
				}
				seenTmdb[k] = true
				e := tvTrendingEntry{tvTrendingItem: tvTrendingItem{Source: kind, TmdbID: m.ID, Title: title}}
				e.Titles = []string{m.Title.Romaji, m.Title.English}
				e.Year = m.SeasonYear
				e.PosterURL = firstNonEmpty(m.CoverImage.ExtraLarge, m.CoverImage.Large)
				e.BackdropURL = m.BannerImage
				e.Overview = tmdbOverview(&m)
				if kind == "tv" {
					tv = append(tv, e)
				} else {
					movie = append(movie, e)
				}
			}
		}
	}

	items := interleaveTrending(tvTrendingCap, anime, tv, movie)
	if len(items) == 0 {
		// nothing to say: the last blob keeps serving, and the next stale
		// read tries again
		slog.Warn("tv trending: nothing built", "partial", partial)
		return
	}

	// German texts and a wide picture for the anime that TMDB knows. Only
	// the kept entries cost a request, and the providers cache them.
	if s.Tmdb.Enabled() {
		for i := range items {
			e := &items[i]
			if e.Source != "anime" || e.TmdbID == 0 || ctx.Err() != nil {
				continue
			}
			kind := "tv"
			if ids, ok := s.animeIDs(e.AnilistID); ok {
				kind = tmdbArtKind(ids.tmdbKind)
			}
			m, err := s.Tmdb.Media(ctx, kind, e.TmdbID)
			if err != nil {
				partial = true
				continue
			}
			if m.Title.Romaji != "" {
				e.Titles = append(e.Titles, m.Title.Romaji)
				e.Title = m.Title.Romaji
			}
			if o := tmdbOverview(m); o != "" {
				e.Overview = o
			}
			if p, w, err := s.Tmdb.Backdrop(ctx, kind, e.TmdbID); err == nil && p != "" && w >= minBackdropWidth {
				e.BackdropURL = s.Tmdb.Images + "/w1280" + p
			} else {
				e.BackdropURL = m.BannerImage
			}
		}
	}
	for i := range items {
		items[i].Rank = i + 1
	}
	b, err := json.Marshal(tvTrendingBlob{BuiltAt: time.Now().Unix(), Partial: partial, Items: items})
	if err != nil {
		return
	}
	s.cacheSet(tvTrendingKey, string(b))
	slog.Info("tv trending built", "items", len(items), "anime", len(anime), "tv", len(tv), "movie", len(movie), "partial", partial)
}

// tmdbOverview is the German overview where TMDB has one, else English, else
// whatever the record's default text is.
func tmdbOverview(m *anilist.Media) string {
	return firstNonEmpty(m.Descriptions["de"], m.Descriptions["en"], plainText(m.Description))
}

// interleaveTrending takes one from each list in turn (anime, tv, movie)
// until limit, skipping the lists that ran out.
func interleaveTrending(limit int, lists ...[]tvTrendingEntry) []tvTrendingEntry {
	out := []tvTrendingEntry{}
	for i := 0; len(out) < limit; i++ {
		took := false
		for _, l := range lists {
			if i < len(l) && len(out) < limit {
				out = append(out, l[i])
				took = true
			}
		}
		if !took {
			break
		}
	}
	return out
}

// tvWatchIndex maps "<source>|<mediaId>" to the user's newest watch whose
// folder is matched to that title.
func (s *Server) tvWatchIndex(userID int64) (map[string]int64, error) {
	rows, err := s.DB.Query(`SELECT w.id, c.source, c.media_id FROM watches w
		JOIN catalog_matches c ON c.server_id = w.server_id AND c.folder = w.remote_path
		WHERE w.user_id = ? AND c.media_id != 0 ORDER BY w.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	idx := map[string]int64{}
	for rows.Next() {
		var id int64
		var src string
		var media int
		if err := rows.Scan(&id, &src, &media); err != nil {
			return nil, err
		}
		idx[src+"|"+strconv.Itoa(media)] = id // the newest wins
	}
	return idx, rows.Err()
}

// handleTVTrending lists what is trending, with the caller's own state.
//
//	@Summary		TV trending
//	@Description	For a paired device (Authorization: Bearer <device token>, scope tv:read). What is trending on AniList and TMDB (anime, series and films, interleaved in that order), at most `limit` (1..50, default 20), optionally of one `kind`. One global list built in the background every few hours and read from the database only, so the list is empty until the first build finished. `inLibrary`, `plexRatingKey` and `watchId` are the caller's own state. `rank` is the position in the whole list.
//	@Tags			TV
//	@Produce		json
//	@Param			limit	query		int		false	"entries, 1..50 (default 20)"
//	@Param			kind	query		string	false	"anime, tv, movie or all (default all)"	Enums(anime, tv, movie, all)
//	@Success		200		{array}		tvTrendingItem
//	@Failure		400		{object}	ErrorResponse
//	@Failure		401		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		DeviceAuth
//	@Router			/api/tv/trending [get]
func (s *Server) handleTVTrending(w http.ResponseWriter, r *http.Request) {
	u := tvUser(r.Context())
	limit := tvIntParam(r, "limit", tvLimitDefault, 1, tvLimitMax)
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "all"
	}
	if !strings.Contains(tvTrendingKinds, "|"+kind+"|") {
		writeErr(w, http.StatusBadRequest, "invalid kind")
		return
	}
	// stale-while-revalidate: the old blob answers, the rebuild runs behind
	s.warmTVTrending()
	blob, _, _ := s.tvTrendingBlob()

	out := []tvTrendingItem{}
	var picked []tvTrendingEntry
	for _, e := range blob.Items {
		if len(picked) == limit {
			break
		}
		if kind == "all" || e.Source == kind {
			picked = append(picked, e)
		}
	}
	if len(picked) == 0 {
		writeJSON(w, http.StatusOK, out)
		return
	}
	watches, err := s.tvWatchIndex(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	owned := s.plexOwnedNoWait()
	plexOn := s.plexLinked()
	for _, e := range picked {
		it := e.tvTrendingItem
		var m anilist.Media
		for i, t := range e.Titles {
			switch i {
			case 0:
				m.Title.Romaji = t
			case 1:
				m.Title.English = t
			case 2:
				m.Title.Native = t
			}
		}
		// the sources the title is known under at the watches, and the
		// media-server series keys it may be filed under
		var srcs, keys []string
		id, tid := strconv.Itoa(e.AnilistID), strconv.Itoa(e.TmdbID)
		tkind := e.Source // the TMDB kind: a series or a film
		if e.Source == "anime" {
			tkind = "tv"
			if ids, ok := s.animeIDs(e.AnilistID); ok {
				tkind = tmdbArtKind(ids.tmdbKind)
			}
			srcs = append(srcs, "anilist|"+id)
			keys = append(keys, "anilist:"+id)
			if e.TvdbID != 0 {
				keys = append(keys, "tvdb:"+strconv.Itoa(e.TvdbID))
			}
		}
		if e.TmdbID != 0 {
			srcs = append(srcs, "tmdb:"+tkind+"|"+tid, "tmdb|"+tid)
			keys = append(keys, "tmdb:"+tid)
		}
		for _, k := range srcs {
			if wid := watches[k]; wid != 0 {
				it.WatchID = wid
				break
			}
		}
		if plexOn {
			for _, k := range keys {
				if rk, _ := s.plexRatingKeyForKind(k, tkind == "movie"); rk != "" {
					it.PlexKey = rk
					break
				}
			}
		}
		if e.Source == "anime" {
			m.ID = e.AnilistID
			it.InLibrary = owned(m, "anilist")
			if !it.InLibrary && e.TmdbID != 0 {
				m.ID = e.TmdbID
				it.InLibrary = owned(m, "tmdb:"+tkind)
			}
		} else {
			m.ID = e.TmdbID
			it.InLibrary = owned(m, "tmdb:"+e.Source)
		}
		it.InLibrary = it.InLibrary || it.PlexKey != ""
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, out)
}
