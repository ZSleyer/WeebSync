package api

import (
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// The read-only API a paired TV launcher reads with its device token (see
// devices.go): what airs soon, and what arrived. Small, flat JSON, built from
// what the database and the provider caches already hold: a TV polling every
// quarter hour never makes the server ask a provider.

const (
	tvPastWindow   = 6 * time.Hour // just aired: still on the TV's row
	tvDaysDefault  = 7
	tvDaysMax      = 14
	tvLimitDefault = 20
	tvLimitMax     = 50
)

// tvCalendarItem is one episode slot of the caller's watches.
type tvCalendarItem struct {
	WatchID   int64 `json:"watchId"`
	AnilistID int   `json:"anilistId,omitempty"` // the AniList id, when the watch is matched there
	// Title as the web UI shows it: the watch's own title, else the
	// provider's display title
	Title      string `json:"title"`
	Episode    int    `json:"episode"`              // in the watch's own numbering
	EpisodeAbs int    `json:"episodeAbs,omitempty"` // the provider's number, when the watch renumbers
	AiringAt   int64  `json:"airingAt"`             // unix seconds
	Dub        bool   `json:"dub"`                  // the slot of a dub release, not the original
	Estimated  bool   `json:"estimated"`            // projected, not a published date
	Have       bool   `json:"have"`                 // the episode is downloaded already
	PosterURL  string `json:"posterUrl,omitempty"`
	// BackdropURL is a 16:9 picture (TMDB, 1280 px), empty while none is known
	BackdropURL   string `json:"backdropUrl,omitempty"`
	PlexRatingKey string `json:"plexRatingKey,omitempty"` // the series in Plex, when linked
}

// tvSeriesArt is what both tv lists say about a series beside its episodes.
type tvSeriesArt struct {
	poster, backdrop, plexKey string
}

// tvIntParam reads a bounded integer query parameter: absent, unreadable
// (only digits count) or out of range falls back to def or is clamped.
func tvIntParam(r *http.Request, name string, def, lo, hi int) int {
	v := r.URL.Query().Get(name)
	if v == "" || strings.Trim(v, "0123456789") != "" || len(v) > 6 {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return min(max(n, lo), hi)
}

// tvTitle mirrors the web UI's watchTitle: the override, else the provider's
// preferred title, else a non-Japanese romaji or english one, else the folder.
func tvTitle(override string, m *anilist.Media, remotePath string) string {
	if override != "" {
		return override
	}
	if m != nil {
		if m.Title.Preferred != "" {
			return m.Title.Preferred
		}
		for _, c := range []string{m.Title.Romaji, m.Title.English} {
			if c != "" && !hasCJK(c) {
				return c
			}
		}
		if m.Title.Romaji != "" {
			return m.Title.Romaji
		}
		if m.Title.English != "" {
			return m.Title.English
		}
	}
	return path.Base(remotePath)
}

// tvArt reads a series' pictures and media-server link from the caches only.
func (s *Server) tvArt(serverID int64, folder, source string, m *anilist.Media, plexOn bool) tvSeriesArt {
	var a tvSeriesArt
	if m != nil {
		a.poster = m.CoverImage.ExtraLarge
		if a.poster == "" {
			a.poster = m.CoverImage.Large
		}
		switch {
		case source == "anilist":
			// the picture /api/media/backdrop finds, if it has been asked
			if ids, ok := s.animeIDs(m.ID); ok && ids.tmdbID != 0 && s.Tmdb != nil {
				kind := ids.tmdbKind
				if kind != "movie" {
					kind = "tv"
				}
				if p, width, ok := s.Tmdb.BackdropCached(kind, ids.tmdbID); ok && p != "" && width >= minBackdropWidth {
					a.backdrop = s.Tmdb.Images + "/w1280" + p
				}
			}
		case strings.HasPrefix(source, "tmdb:"):
			a.backdrop = m.BannerImage // TMDB's own backdrop at 1280 px
		}
	}
	if plexOn {
		if showKey, _, isMovie := s.folderUnit(serverID, folder); showKey != "" {
			a.plexKey, _ = s.plexRatingKeyForKind(showKey, isMovie)
		}
	}
	return a
}

// plexLinked says whether the configured media server is Plex: the stored
// series keys are Plex rating keys then. Nothing is asked of the server.
func (s *Server) plexLinked() bool {
	c := s.plexClient()
	return c != nil && c.Kind() == "plex"
}

// handleTVCalendar lists what airs for the device's user.
//
//	@Summary		TV calendar
//	@Description	For a paired device (Authorization: Bearer <device token>, scope tv:read). The caller's own watches' episode slots from 6 hours ago up to `days` days ahead (1..14, default 7), flat and sorted by airingAt. Built from cached data only.
//	@Tags			TV
//	@Produce		json
//	@Param			days	query		int	false	"days ahead, 1..14 (default 7)"
//	@Success		200		{array}		tvCalendarItem
//	@Failure		401		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		DeviceAuth
//	@Router			/api/tv/calendar [get]
func (s *Server) handleTVCalendar(w http.ResponseWriter, r *http.Request) {
	u := tvUser(r.Context())
	days := tvIntParam(r, "days", tvDaysDefault, 1, tvDaysMax)
	list, err := s.watchesFor(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	now := time.Now()
	from, until := now.Add(-tvPastWindow).Unix(), now.Add(time.Duration(days)*24*time.Hour).Unix()
	plexOn := s.plexLinked()
	out := []tvCalendarItem{}
	for _, wt := range list {
		if wt.UserID != u.ID {
			continue // watchesFor is per user already; never trust it blindly
		}
		var art tvSeriesArt
		artDone := false
		for _, a := range wt.Airings {
			if a.At < from || a.At > until {
				continue
			}
			if !artDone {
				art = s.tvArt(wt.ServerID, wt.RemotePath, wt.MediaSource, wt.Media, plexOn)
				artDone = true
			}
			it := tvCalendarItem{
				WatchID: wt.ID, Title: tvTitle(wt.TitleOverride, wt.Media, wt.RemotePath),
				Episode: a.Episode, EpisodeAbs: a.EpisodeAbs, AiringAt: a.At,
				Dub: a.Dub != "", Estimated: a.Est, Have: a.Have,
				PosterURL: art.poster, BackdropURL: art.backdrop, PlexRatingKey: art.plexKey,
			}
			if wt.MediaSource == "anilist" {
				it.AnilistID = wt.MediaID
			}
			out = append(out, it)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].AiringAt != out[j].AiringAt {
			return out[i].AiringAt < out[j].AiringAt
		}
		return out[i].WatchID < out[j].WatchID
	})
	writeJSON(w, http.StatusOK, out)
}

// tvRecentItem is one episode that finished downloading.
type tvRecentItem struct {
	WatchID       int64  `json:"watchId,omitempty"` // the caller's watch that feeds the folder; absent for a one-off download
	Title         string `json:"title"`
	Season        int    `json:"season,omitempty"`
	Episode       int    `json:"episode,omitempty"` // absent when the name carries none (a film)
	FinishedAt    int64  `json:"finishedAt"`        // unix seconds of the newest copy
	PosterURL     string `json:"posterUrl,omitempty"`
	BackdropURL   string `json:"backdropUrl,omitempty"`
	PlexRatingKey string `json:"plexRatingKey,omitempty"`
}

// tvGroup is one series folder of the recent list.
type tvGroup struct {
	watchID int64
	title   string
	art     tvSeriesArt
}

// tvRecentScan bounds the rows read for one answer: many copies of few
// episodes still fill the list, and the cost stays fixed.
const tvRecentScan = 1000

// handleTVRecent lists what finished downloading for the device's user.
//
//	@Summary		TV recent downloads
//	@Description	For a paired device (Authorization: Bearer <device token>, scope tv:read). The caller's own finished downloads, one entry per episode (the newest copy), newest first, at most `limit` (1..50, default 20). Built from cached data only.
//	@Tags			TV
//	@Produce		json
//	@Param			limit	query		int	false	"entries, 1..50 (default 20)"
//	@Success		200		{array}		tvRecentItem
//	@Failure		401		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		DeviceAuth
//	@Router			/api/tv/recent [get]
func (s *Server) handleTVRecent(w http.ResponseWriter, r *http.Request) {
	u := tvUser(r.Context())
	limit := tvIntParam(r, "limit", tvLimitDefault, 1, tvLimitMax)
	list, err := s.tvDoneDownloads(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}

	plexOn := s.plexLinked()
	showOf := map[string]string{}
	groups := map[string]tvGroup{}
	seen := map[string]bool{}
	out := []tvRecentItem{}
	for _, d := range list {
		if len(out) == limit {
			break
		}
		dir := path.Dir(d.remote)
		fk := strconv.FormatInt(d.serverID, 10) + "|" + dir
		folder, ok := showOf[fk]
		if !ok {
			folder = s.showFolder(d.serverID, dir)
			showOf[fk] = folder
		}
		season, episode := episodeNumbers(path.Base(d.local), path.Base(d.remote))
		gk := strconv.FormatInt(d.serverID, 10) + "|" + folder
		ek := gk + "|" + strconv.Itoa(epKey(season, episode))
		if episode == 0 {
			ek = gk + "|" + d.remote // no number: one entry per file
		}
		if seen[ek] {
			continue // an older copy of an episode already listed
		}
		seen[ek] = true
		g, ok := groups[gk]
		if !ok {
			g = s.tvRecentGroup(u.ID, d.serverID, folder, plexOn)
			groups[gk] = g
		}
		finished, perr := time.ParseInLocation("2006-01-02 15:04:05", d.at, time.UTC)
		if perr != nil {
			continue // a row without a readable end is not "recent"
		}
		out = append(out, tvRecentItem{
			WatchID: g.watchID, Title: g.title, Season: season, Episode: episode, FinishedAt: finished.Unix(),
			PosterURL: g.art.poster, BackdropURL: g.art.backdrop, PlexRatingKey: g.art.plexKey,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// tvDone is one finished download of the recent list.
type tvDone struct {
	serverID          int64
	remote, local, at string
}

// tvDoneDownloads reads the user's finished downloads, newest first.
func (s *Server) tvDoneDownloads(userID int64) ([]tvDone, error) {
	rows, err := s.DB.Query(`SELECT server_id, remote_path, local_path, updated_at FROM downloads
		WHERE user_id = ? AND status = 'done' ORDER BY updated_at DESC, id DESC LIMIT ?`, userID, tvRecentScan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []tvDone
	for rows.Next() {
		var d tvDone
		if err := rows.Scan(&d.serverID, &d.remote, &d.local, &d.at); err != nil {
			return nil, err
		}
		list = append(list, d)
	}
	return list, rows.Err()
}

// tvRecentGroup describes one series folder of the caller's downloads: the
// caller's own watch over it, its title and pictures. The watch lookup is
// scoped to the caller, so another user's watch on the same path never
// lends its id or title.
func (s *Server) tvRecentGroup(userID, serverID int64, folder string, plexOn bool) (g tvGroup) {
	source, mediaID := s.folderMatch(serverID, folder)
	var m *anilist.Media
	if source != "" && mediaID != 0 {
		m, _ = s.sourceMedia(source, mediaID)
	}
	var override string
	// display metadata: no watch is the fallback
	_ = s.DB.QueryRow(`SELECT id, title_override FROM watches
		WHERE user_id = ? AND server_id = ?
		  AND (?3 = rtrim(remote_path, '/') OR substr(?3, 1, length(rtrim(remote_path, '/')) + 1) = rtrim(remote_path, '/') || '/')
		ORDER BY length(remote_path) DESC LIMIT 1`, userID, serverID, folder).Scan(&g.watchID, &override)
	g.title = tvTitle(override, m, folder)
	g.art = s.tvArt(serverID, folder, source, m, plexOn)
	return g
}
