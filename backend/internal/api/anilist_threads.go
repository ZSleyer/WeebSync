package api

import (
	"net/http"
	"strconv"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// handleAnilistThread serves one AniList forum thread for the in-app reader:
// the opening post and one page of comments, replies flattened one level.
//
//	@Summary		AniList thread
//	@Description	Opening post and one page (25 top-level comments) of an AniList forum thread. Bodies are AniList markdown, capped in size; replies are flattened under their top-level comment, at most three levels deep.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id		path		int	true	"AniList thread id"
//	@Param			page	query		int	false	"Comment page, 1-based (default 1)"
//	@Success		200		{object}	anilist.ThreadPage
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/threads/{id} [get]
func (s *Server) handleAnilistThread(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	page := 1
	if v := r.URL.Query().Get("page"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 1000 {
			writeErr(w, http.StatusBadRequest, "invalid page")
			return
		}
		page = p
	}
	var tp *anilist.ThreadPage
	tp, err := s.Anilist.Thread(r.Context(), id, page)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tp)
}
