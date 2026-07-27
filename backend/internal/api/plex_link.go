package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/plex"
)

// Binding a watch to a Plex show is really binding its SERIES: the show is a
// property of the series, not of one folder subscription, so the choice carries
// to every watch of the same series. Watches are only the handle, because they
// are the one place in the UI where a Plex show is already talked about.

// PlexShowRef names one show in the library.
type PlexShowRef struct {
	RatingKey string `json:"ratingKey" example:"62755"`
	Title     string `json:"title" example:"Re:ZERO - Starting Life in Another World"`
	Year      int    `json:"year" example:"2016"`
	Library   string `json:"library" example:"Animeserien"`
}

// PlexShowResponse is the show a watch currently resolves to, how it was found,
// and what else could be picked instead.
type PlexShowResponse struct {
	Show *PlexShowRef `json:"show,omitempty"`
	// Source names the route that resolved it: manual (set by hand), series (the
	// ids the series carries), path (the folder Plex scanned), title (guessed),
	// none (unresolved - nothing is changed in the library).
	Source     string        `json:"source" example:"series"`
	Candidates []PlexShowRef `json:"candidates"`
}

// plexShowLinkRequest sets or clears the hand-picked show. An empty ratingKey
// removes the binding and hands the series back to the automatic routes.
type plexShowLinkRequest struct {
	RatingKey string `json:"ratingKey" example:"62755"`
}

// handleWatchPlexShow reports which Plex show a watch resolves to and offers the
// library as alternatives.
//
//	@Summary		Plex show behind a watch
//	@Description	The Plex show the watch's series resolves to, the route that found it, and the library's shows as alternatives. Filter the candidates with q.
//	@Tags			Watches
//	@Produce		json
//	@Param			id	path		int		true	"Watch ID"
//	@Param			q	query		string	false	"Filter candidates by title"
//	@Success		200	{object}	PlexShowResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		503	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/watches/{id}/plex-show [get]
func (s *Server) handleWatchPlexShow(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.watchForUser(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	c := s.plexClient()
	if c == nil {
		writeErr(w, http.StatusServiceUnavailable, "Plex is not configured")
		return
	}
	resp := PlexShowResponse{Source: "none", Candidates: []PlexShowRef{}}
	if sh, _, how, ok := s.plexShowForWatch(wt, GuessTitle(path.Base(wt.RemotePath))); ok {
		resp.Source, resp.Show = how, &PlexShowRef{RatingKey: sh.RatingKey, Title: sh.Title, Year: sh.Year}
		if _, manual := s.plexRatingKeyFor(s.watchShowKey(wt)); manual {
			resp.Source = "manual"
		}
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	for _, ref := range s.plexShowList(c) {
		if q == "" || strings.Contains(strings.ToLower(ref.Title), q) {
			resp.Candidates = append(resp.Candidates, ref)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleWatchPlexShowLink binds the watch's series to a Plex show by hand.
//
//	@Summary		Bind a watch's series to a Plex show
//	@Description	Sets the Plex show for the series behind this watch, outranking every automatic lookup. An empty ratingKey removes the binding. The choice applies to every watch of the same series.
//	@Tags			Watches
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int					true	"Watch ID"
//	@Param			body	body	plexShowLinkRequest	true	"Show to bind"
//	@Success		204
//	@Failure		400	{object}	ErrorResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		409	{object}	ErrorResponse
//	@Failure		503	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/watches/{id}/plex-show [put]
func (s *Server) handleWatchPlexShowLink(w http.ResponseWriter, r *http.Request) {
	wt, ok := s.watchForUser(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	var in plexShowLinkRequest
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	seriesID := s.seriesIDForFolder(wt.ServerID, wt.RemotePath)
	if seriesID == 0 {
		writeErr(w, http.StatusNotFound, "this watch is not matched to a series yet")
		return
	}
	if in.RatingKey == "" {
		s.DB.Exec(`DELETE FROM series_provider WHERE series_id = ? AND source = 'plex'`, seriesID)
		slog.Info("plex link cleared", "series", seriesID, "watch", wt.ID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	rk, err := strconv.Atoi(in.RatingKey)
	if err != nil || rk <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid ratingKey")
		return
	}
	if other := s.seriesByProvider("plex", rk); other != 0 && other != seriesID {
		writeErr(w, http.StatusConflict, "that Plex show is already bound to another series")
		return
	}
	c := s.plexClient()
	if c == nil {
		writeErr(w, http.StatusServiceUnavailable, "Plex is not configured")
		return
	}
	sh, err := c.ShowDetail(in.RatingKey)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "no such show in Plex")
		return
	}
	// everything is checked, so the old link can go: a rejected request must
	// leave the series with the binding it had
	s.DB.Exec(`DELETE FROM series_provider WHERE series_id = ? AND source = 'plex'`, seriesID)
	// a chosen show is an exact binding, so it may unite what its ids name
	s.attachPlexIdentity(seriesID, plexGuid{
		TVDB: sh.TVDBID, TMDB: sh.TMDBID, IMDB: sh.IMDBID, Year: sh.Year, RatingKey: sh.RatingKey,
	}, true)
	s.DB.Exec(`UPDATE series_provider SET manual = 1 WHERE series_id = ? AND source = 'plex' AND media_id = ?`,
		seriesID, rk)
	slog.Info("plex link set by hand", "series", seriesID, "watch", wt.ID, "ratingKey", rk)
	w.WriteHeader(http.StatusNoContent)
}

// watchForUser loads the watch named by the request path, scoped to its owner.
func (s *Server) watchForUser(r *http.Request) (Watch, bool) {
	u := auth.UserFrom(r.Context())
	var wt Watch
	if s.DB.QueryRow(`SELECT id, server_id, remote_path, local_path, subfolder FROM watches WHERE id = ? AND user_id = ?`,
		pathID(r), u.ID).Scan(&wt.ID, &wt.ServerID, &wt.RemotePath, &wt.LocalPath, &wt.Subfolder) != nil {
		return Watch{}, false
	}
	return wt, true
}

// watchShowKey is the cross-provider show identity of a watch's folder.
func (s *Server) watchShowKey(w Watch) string {
	showKey, _, _ := s.folderUnit(w.ServerID, w.RemotePath)
	return showKey
}

// plexShowList is every show of the show libraries, for the picker. Cached for
// an hour: the same round of listings the guid index already pays for.
func (s *Server) plexShowList(c *plex.Client) []PlexShowRef {
	var out []PlexShowRef
	if p, ok := s.cacheGet("plex:showlist:v1", time.Hour); ok {
		json.Unmarshal([]byte(p), &out)
		return out
	}
	secs, err := c.Sections()
	if err != nil {
		return nil
	}
	for _, sec := range secs {
		if sec.Type != "show" {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			out = append(out, PlexShowRef{RatingKey: sh.RatingKey, Title: sh.Title, Year: sh.Year, Library: sec.Title})
		}
	}
	if p, err := json.Marshal(out); err == nil {
		s.cacheSet("plex:showlist:v1", string(p))
	}
	return out
}
