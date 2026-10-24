package api

import (
	"net/http"
	"strconv"
)

// minBackdropWidth: below it a backdrop is no sharper than AniList's banner
const minBackdropWidth = 1280

// backdropResponse is a title's wide picture in two sizes, empty when there
// is none better than what the title brings itself.
type backdropResponse struct {
	// URL is TMDB's 1280 px backdrop
	URL string `json:"url"`
	// Large is the same picture at its original size, for screens that need more
	Large string `json:"large"`
}

// handleMediaBackdrop finds a sharper banner for an AniList title: AniList's
// own is a 1900x400 strip, which a card's taller hero has to blow up on a
// phone. Through the anime id mapping the title's TMDB entry is looked up,
// whose backdrop is 16:9 and comes at full size. GET /api/media/backdrop?source=anilist&id=123
//
//	@Summary		Media backdrop
//	@Description	A sharper wide picture for an AniList title, from its TMDB entry when the anime id mapping knows one.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			source	query		string	false	"Metadata source: anilist (default)"
//	@Param			id		query		int		true	"Media id"
//	@Success		200		{object}	backdropResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/media/backdrop [get]
func (s *Server) handleMediaBackdrop(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	if src := r.URL.Query().Get("source"); src != "" && src != "anilist" {
		writeErr(w, http.StatusBadRequest, "unknown source")
		return
	}
	out := backdropResponse{}
	ids, ok := s.animeIDs(id)
	if !ok || ids.tmdbID == 0 || !s.Tmdb.Enabled() {
		writeJSON(w, http.StatusOK, out)
		return
	}
	kind := ids.tmdbKind
	if kind != "movie" {
		kind = "tv"
	}
	path, width, err := s.Tmdb.Backdrop(r.Context(), kind, ids.tmdbID)
	if err != nil {
		// not "no picture": the client caches an empty answer for a day
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// no picture, or only a small one, is an answer too: the card keeps
	// AniList's banner, which is wider than a small backdrop
	if path != "" && width >= minBackdropWidth {
		out.URL = s.Tmdb.Images + "/w1280" + path
		out.Large = s.Tmdb.Images + "/original" + path
	}
	writeJSON(w, http.StatusOK, out)
}
