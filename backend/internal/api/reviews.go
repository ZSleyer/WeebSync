package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// reviewsResponse wraps the community-review list for the detail modal.
type reviewsResponse struct {
	Reviews []anilist.Review `json:"reviews"`
}

// handleMediaReviews serves community reviews for the detail modal, lazily:
// GET /api/media/reviews?source=anilist|tmdb:tv|tmdb:movie&id=123
//
//	@Summary		Media reviews
//	@Description	Community reviews for a title from AniList or TMDB.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			source	query		string	false	"Metadata source: anilist (default) | tmdb:tv | tmdb:movie"
//	@Param			id		query		int		true	"Media id"
//	@Success		200		{object}	reviewsResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/media/reviews [get]
func (s *Server) handleMediaReviews(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	source := r.URL.Query().Get("source")
	var (
		reviews []anilist.Review
		err     error
	)
	switch {
	case source == "" || source == "anilist":
		reviews, err = s.Anilist.Reviews(r.Context(), id)
	case strings.HasPrefix(source, "tmdb:"):
		reviews, err = s.Tmdb.Reviews(r.Context(), source[5:], id)
	default:
		writeErr(w, http.StatusBadRequest, "unknown source")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if reviews == nil {
		reviews = []anilist.Review{}
	}
	writeJSON(w, http.StatusOK, reviewsResponse{Reviews: reviews})
}
