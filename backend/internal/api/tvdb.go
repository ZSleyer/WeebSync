package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

// TVDB as a catalog metadata source: a folder marked 'tvdb' matches against
// TheTVDB instead of AniList/TMDB. Mirrors the TMDB wiring (queue match, queue
// fetch, search/media endpoints) with the "tvdb" source tag.

// queueTvdbMatch resolves one folder against TVDB in the background.
func (s *Server) queueTvdbMatch(serverID int64, folder, name string, force bool) {
	s.runJob(fmt.Sprintf("m:%d:%s", serverID, folder), func(ctx context.Context) {
		mediaID, _, err := s.tvdbLookup(ctx, serverID, folder, name)
		if err != nil {
			return // retried by the next catalog poll
		}
		// persistMatch logs a failure; the next catalog poll retries
		_ = s.persistMatch(serverID, folder, mediaID, false, "tvdb")
	})
}

// tvdbLookup finds the TVDB series a folder names, 0 when none carries one of
// the folder's names. An error means the search itself failed. The search
// result the series was found as comes with it (nil for what Plex identified).
func (s *Server) tvdbLookup(ctx context.Context, serverID int64, folder, name string) (int, *anilist.Media, error) {
	// Plex has already identified a show of this name and year: its id
	// beats any title search (12 of 12 against a search that missed some)
	mediaID, _ := s.matchLocalByPlexID(folder, "tvdb")
	var hit *anilist.Media
	year, _ := strconv.Atoi(yearRe.FindString(name))
	for _, q := range s.liveQueries(serverID, folder, name) {
		if mediaID != 0 {
			break
		}
		var hits []tvdb.Hit
		if year != 0 {
			// the year finds what popularity buries ("Squid Game" 2021)
			h, err := s.Tvdb.SearchYear(ctx, q.q, year)
			if err != nil {
				return 0, nil, err
			}
			hits = h
		}
		h, err := s.Tvdb.SearchHits(ctx, q.q, "")
		if err != nil {
			return 0, nil, err
		}
		hits = append(hits, h...)
		cands := make([]liveCand, 0, len(hits))
		for _, h := range hits {
			cands = append(cands, liveCand{id: h.Media.ID, year: h.Media.SeasonYear, titles: h.Titles, anime: s.inAnimeIDs("tvdb", h.Media.ID), media: withTitles(h)})
		}
		if c, ok := pickLiveCand(name, q.accept, cands); ok {
			mediaID, hit = c.id, &c.media
		}
	}
	if mediaID != 0 {
		s.Tvdb.Media(ctx, mediaID) // full details into the cache first
	}
	return mediaID, hit, nil
}

// queueTvdbMovieMatch resolves a film folder against TVDB's films, the way
// queueTvdbMatch does a series: Plex's id first, then a search whose hit must
// carry one of the folder's names, the year as a veto beyond two.
func (s *Server) queueTvdbMovieMatch(serverID int64, folder, name string) {
	s.runJob(fmt.Sprintf("m:%d:%s", serverID, folder), func(ctx context.Context) {
		mediaID, _, err := s.tvdbMovieLookup(ctx, serverID, folder, name)
		if err != nil {
			return // retried by the next catalog poll
		}
		// persistMatch logs a failure; the next catalog poll retries
		_ = s.persistMatch(serverID, folder, mediaID, false, tvdbMovieSource)
	})
}

// tvdbMovieLookup is tvdbLookup for TVDB's films.
func (s *Server) tvdbMovieLookup(ctx context.Context, serverID int64, folder, name string) (int, *anilist.Media, error) {
	mediaID, _ := s.matchLocalByPlexID(folder, tvdbMovieSource)
	var hit *anilist.Media
	year, _ := strconv.Atoi(yearRe.FindString(name))
	for _, q := range s.liveQueries(serverID, folder, name) {
		if mediaID != 0 {
			break
		}
		var hits []tvdb.Hit
		if year != 0 {
			h, err := s.Tvdb.SearchMovies(ctx, q.q, "", year)
			if err != nil {
				return 0, nil, err
			}
			hits = h
		}
		h, err := s.Tvdb.SearchMovies(ctx, q.q, "", 0)
		if err != nil {
			return 0, nil, err
		}
		hits = append(hits, h...)
		cands := make([]liveCand, 0, len(hits))
		for _, h := range hits {
			cands = append(cands, liveCand{id: h.Media.ID, year: h.Media.SeasonYear, titles: h.Titles,
				anime: slices.Contains(h.Media.Genres, "Anime"), media: withTitles(h)})
		}
		if c, ok := pickLiveCand(name, q.accept, cands); ok {
			mediaID, hit = c.id, &c.media
		}
	}
	if mediaID != 0 {
		s.Tvdb.Movie(ctx, mediaID) // full details into the cache first
	}
	return mediaID, hit, nil
}

// withTitles is a TVDB search result with every title it is known by (the name,
// its translations and aliases) as synonyms: the name it was found under may be
// any of them.
func withTitles(h tvdb.Hit) anilist.Media {
	m := h.Media
	m.Synonyms = append([]string(nil), h.Titles...)
	return m
}

// queueTvdbMovieFetch refreshes a missing or stale TVDB film in the background.
func (s *Server) queueTvdbMovieFetch(id int) {
	s.runJob(fmt.Sprintf("tvmf:%d", id), func(ctx context.Context) {
		s.refetchCached(fmt.Sprintf("tvdb:movie:media:%d", id), func() error {
			_, err := s.Tvdb.Movie(ctx, id)
			return err
		})
	})
}

// queueTvdbFetch refreshes missing/stale TVDB media in the background.
func (s *Server) queueTvdbFetch(id int) {
	s.runJob(fmt.Sprintf("tvf:%d", id), func(ctx context.Context) {
		s.refetchCached(fmt.Sprintf("tvdb:media:%d", id), func() error {
			_, err := s.Tvdb.Media(ctx, id)
			return err
		})
	})
}

// tvdbMeResponse is the connection status shown on the settings page. TVDB's
// v4 login returns a bare token, so there is no account name to report.
type tvdbMeResponse struct {
	Configured bool   `json:"configured"`
	Connected  bool   `json:"connected"`
	Error      string `json:"error,omitempty"`
}

// handleTvdbMe checks the configured API key by logging in. force=1 skips the
// cached token, backing the "test connection" button. Always 200: a rejected
// key is a status, not a request failure.
//
//	@Summary		TVDB connection status
//	@Description	Report whether the configured TheTVDB API key can log in.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			force	query		bool	false	"Bypass the cached token and log in again"
//	@Success		200		{object}	tvdbMeResponse
//	@Security		CookieAuth
//	@Router			/api/tvdb/me [get]
func (s *Server) handleTvdbMe(w http.ResponseWriter, r *http.Request) {
	if !s.Tvdb.Enabled() {
		writeJSON(w, http.StatusOK, tvdbMeResponse{})
		return
	}
	// a forced fresh login at TVDB spends the instance's quota: an admin's
	force := r.URL.Query().Get("force") != "" && auth.UserFrom(r.Context()).IsAdmin
	if err := s.Tvdb.Ping(r.Context(), force); err != nil {
		writeJSON(w, http.StatusOK, tvdbMeResponse{Configured: true, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tvdbMeResponse{Configured: true, Connected: true})
}

// handleTvdbSearch backs the match dialog for tvdb-scoped folders.
// GET /api/tvdb/search?q=
//
//	@Summary		Search TVDB
//	@Description	Search TheTVDB series, or films with kind=movie, by title for the match dialog.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			q		query		string	true	"Search query"
//	@Param			kind	query		string	false	"series (default) | movie"
//	@Success		200		{array}		anilist.Media
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
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
	search := s.Tvdb.SearchHits
	if r.URL.Query().Get("kind") == "movie" {
		search = func(ctx context.Context, q, lang string) ([]tvdb.Hit, error) {
			return s.Tvdb.SearchMovies(ctx, q, lang, 0)
		}
	}
	hits, err := search(r.Context(), q, s.userLocale(u.ID))
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
//	@Description	Resolve a single TheTVDB series entry, or film with kind=movie, by id.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id		query		int		true	"TVDB id"
//	@Param			kind	query		string	false	"series (default) | movie"
//	@Success		200		{object}	anilist.Media
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/tvdb/media [get]
func (s *Server) handleTvdbMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	get := s.Tvdb.Media
	if r.URL.Query().Get("kind") == "movie" {
		get = s.Tvdb.Movie // films are numbered apart from series
	}
	m, err := get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}
