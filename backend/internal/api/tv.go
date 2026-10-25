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
