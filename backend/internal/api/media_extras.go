package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

// mediaExtrasResponse is everything the title card shows beyond the media
// record: related titles, recommendations, cast, links and forum threads.
// Every list is present, empty where the source has nothing.
type mediaExtrasResponse struct {
	Relations       []anilist.Relation     `json:"relations"`
	Recommendations []recommendedMedia     `json:"recommendations"`
	Characters      []anilist.Character    `json:"characters"`
	Links           []anilist.ExternalLink `json:"links"`
	Threads         []anilist.Thread       `json:"threads"`
	// Synonyms: alternative titles of the media (AniList only), for
	// shortening thread titles that repeat them.
	Synonyms []string `json:"synonyms"`
}

// recommendedMedia is a recommended title with the strength of the
// recommendation. Media is embedded so the JSON stays the flat media object
// every card already reads, with rating beside its fields.
type recommendedMedia struct {
	anilist.Media
	// Rating is the net vote count AniList users gave the recommendation;
	// absent for TMDB, which has no votes on it.
	Rating int `json:"rating,omitempty"`
}

// handleMediaExtras serves the title card's secondary tabs, lazily:
// GET /api/media/extras?source=anilist|tmdb:tv|tmdb:movie&id=123
//
//	@Summary		Media extras
//	@Description	Related titles, recommendations, cast, external links and forum threads for a title from AniList or TMDB.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			source	query		string	false	"Metadata source: anilist (default) | tmdb:tv | tmdb:movie"
//	@Param			id		query		int		true	"Media id"
//	@Success		200		{object}	mediaExtrasResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/media/extras [get]
func (s *Server) handleMediaExtras(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	out := mediaExtrasResponse{
		Relations:       []anilist.Relation{},
		Recommendations: []recommendedMedia{},
		Characters:      []anilist.Character{},
		Links:           []anilist.ExternalLink{},
		Threads:         []anilist.Thread{},
		Synonyms:        []string{},
	}
	source := r.URL.Query().Get("source")
	switch {
	case source == "" || source == "anilist":
		// the two batches are the suggestion sweep's caches, warm for every
		// title it has seen; only the cast/links/threads query is new
		rels, err := s.Anilist.RelationsBatch(r.Context(), []int{id})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		recs, err := s.Anilist.RecommendationsBatch(r.Context(), []int{id})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		x, err := s.Anilist.Extras(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		if rels[id] != nil {
			out.Relations = rels[id]
		}
		for _, rc := range recs[id] {
			out.Recommendations = append(out.Recommendations, recommendedMedia{Media: rc.Media, Rating: rc.Rating})
		}
		out.Characters, out.Links, out.Threads = x.Characters, x.Links, x.Threads
		if x.Synonyms != nil {
			out.Synonyms = x.Synonyms
		}
	case strings.HasPrefix(source, "tmdb:"):
		if !tmdb.ValidKind(source[5:]) {
			writeErr(w, http.StatusBadRequest, "unknown source")
			return
		}
		recs, cast, err := s.Tmdb.Extras(r.Context(), source[5:], id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		for _, m := range recs {
			out.Recommendations = append(out.Recommendations, recommendedMedia{Media: m})
		}
		out.Characters = cast
	case (source == "tvdb" || source == tvdbMovieSource) && s.Tvdb != nil:
		// TVDB has the cast, the links and the other names; no relations
		// and no recommendations to offer
		x, err := s.Tvdb.Extras(r.Context(), id, source == tvdbMovieSource)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out.Characters, out.Links, out.Synonyms = x.Characters, x.Links, x.Synonyms
	default:
		writeErr(w, http.StatusBadRequest, "unknown source")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
