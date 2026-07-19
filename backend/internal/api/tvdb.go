package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// TVDB as a catalog metadata source: a folder marked 'tvdb' matches against
// TheTVDB instead of AniList/TMDB. Mirrors the TMDB wiring (queue match, queue
// fetch, search/media endpoints) with the "tvdb" source tag.

// queueTvdbMatch resolves one folder against TVDB in the background.
func (s *Server) queueTvdbMatch(serverID int64, folder, name string, force bool) {
	s.runJob(fmt.Sprintf("m:%d:%s", serverID, folder), func(ctx context.Context) {
		query := GuessTitle(name)
		list, err := s.Tvdb.SearchMedia(ctx, query)
		if err != nil {
			return // retried by the next catalog poll
		}
		if len(list) == 0 && GuessAltTitle(name) != "" {
			if list, err = s.Tvdb.SearchMedia(ctx, GuessAltTitle(name)); err != nil {
				return
			}
		}
		if nq := match.Normalize(query); len(list) == 0 && nq != normTitle(query) {
			if list, err = s.Tvdb.SearchMedia(ctx, nq); err != nil {
				return
			}
		}
		mediaID := 0
		if len(list) > 0 {
			mediaID = list[0].ID
		}
		s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, 0, ?)`,
			serverID, folder, mediaID, "tvdb")
		if mediaID != 0 {
			s.Tvdb.Media(ctx, mediaID) // full details into the cache
		}
	})
}

// queueTvdbFetch refreshes missing/stale TVDB media in the background.
func (s *Server) queueTvdbFetch(id int) {
	s.runJob(fmt.Sprintf("tvf:%d", id), func(ctx context.Context) {
		s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`, fmt.Sprintf("tvdb:media:%d", id))
		s.Tvdb.Media(ctx, id)
	})
}

// handleTvdbSearch backs the match dialog for tvdb-scoped folders.
// GET /api/tvdb/search?q=
//
//	@Summary		Search TVDB
//	@Description	Search TheTVDB series by title for the match dialog.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			q	query		string	true	"Search query"
//	@Success		200	{array}		anilist.Media
//	@Failure		400	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/tvdb/search [get]
func (s *Server) handleTvdbSearch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "q required")
		return
	}
	// localize the displayed titles to the user's language (native in parens)
	hits, err := s.Tvdb.SearchHits(r.Context(), q, s.userLocale(u.ID))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	list := make([]anilist.Media, 0, len(hits))
	for _, h := range hits {
		list = append(list, h.Media)
	}
	writeJSON(w, http.StatusOK, list)
}

// handleTvdbMedia resolves one TVDB id (match dialog: pasted id or link).
// GET /api/tvdb/media?id=123
//
//	@Summary		TVDB media
//	@Description	Resolve a single TheTVDB series entry by id.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id	query		int	true	"TVDB id"
//	@Success		200	{object}	anilist.Media
//	@Failure		400	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/tvdb/media [get]
func (s *Server) handleTvdbMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	m, err := s.Tvdb.Media(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}
