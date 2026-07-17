package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// handleMediaReviews serves community reviews for the detail modal, lazily:
// GET /api/media/reviews?source=anilist|tmdb:tv|tmdb:movie&id=123
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
	writeJSON(w, http.StatusOK, map[string]any{"reviews": reviews})
}
