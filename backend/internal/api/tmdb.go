package api

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// Folder scopes: a folder marked 'tv' or 'movie' switches catalog matching
// for the folders directly inside it from AniList (anime, the default) to TMDB.

// scopeFor returns the scope kind (”, 'tv', 'movie') marked on a path. Marks
// do not reach into subfolders: a catalog view describes the folder it was
// chosen for, and a level deeper is usually a different kind of listing
// (seasons, versions) that should not be matched as titles again.
func (s *Server) scopeFor(serverID int64, p string) string {
	var kind string
	s.DB.QueryRow(`SELECT kind FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, p).Scan(&kind)
	return kind
}

// scopeResponse reports the metadata scope of a catalog path.
type scopeResponse struct {
	Scope string `json:"scope"` // "" | anime | tv | movie
}

// handleCatalogScopeGet reports the scope of a path without listing the folder
// or triggering matching - cheap enough for the browser to probe on navigation
// and auto-open catalog folders in catalog view.
// GET /api/servers/{id}/catalog/scope?path=...
//
//	@Summary		Get catalog scope
//	@Description	Report the metadata scope marked on a catalog path.
//	@Tags			Catalog
//	@Produce		json
//	@Param			id		path		int		true	"Server id"
//	@Param			path	query		string	false	"Directory (defaults to the server root)"
//	@Success		200		{object}	scopeResponse
//	@Failure		404		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/scope [get]
func (s *Server) handleCatalogScopeGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var rootPath string
	if serverID == localServerID {
		rootPath = "/" // local pseudo server: no row, root is the download root
	} else if err := s.DB.QueryRow(`SELECT root_path FROM servers WHERE id = ? AND user_id = ?`,
		serverID, u.ID).Scan(&rootPath); err != nil {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = rootPath
	}
	writeJSON(w, http.StatusOK, scopeResponse{Scope: s.scopeFor(serverID, dir)})
}

// sourceForScope maps a scope kind to the catalog_matches source tag.
// 'anime' is an explicit override mark below a TMDB/TVDB-scoped folder.
func sourceForScope(kind string) string {
	switch kind {
	case "", "anime":
		return "anilist"
	case "tvdb":
		return "tvdb"
	default:
		return "tmdb:" + kind // tv | movie
	}
}

// scopeRequest is the body of handleCatalogScope.
type scopeRequest struct {
	Path string `json:"path"`
	Kind string `json:"kind"` // "" | anime | tv | movie
}

// handleCatalogScope sets or clears a folder mark.
// PUT /api/servers/{id}/catalog/scope {path, kind: ”|'tv'|'movie'}
//
//	@Summary		Set catalog scope
//	@Description	Set or clear the metadata-source mark on a folder (empty kind clears it).
//	@Tags			Catalog
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int				true	"Server id"
//	@Param			body	body		scopeRequest	true	"Path and scope kind"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/scope [put]
func (s *Server) handleCatalogScope(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var in scopeRequest
	if !readJSON(w, r, &in) {
		return
	}
	switch in.Kind {
	case "", "anime", "tv", "movie", "tvdb":
	default:
		writeErr(w, http.StatusBadRequest, "invalid kind")
		return
	}
	if (in.Kind == "tv" || in.Kind == "movie") && !s.Tmdb.Enabled() {
		writeErr(w, http.StatusBadRequest, "TMDB API key required")
		return
	}
	if in.Kind == "tvdb" && !s.Tvdb.Enabled() {
		writeErr(w, http.StatusBadRequest, "TVDB API key required")
		return
	}
	// ownership check doubles as root path lookup (empty path = root); the
	// local pseudo server has no row and no owner, its root is just "/"
	if serverID == localServerID {
		if in.Path == "" {
			in.Path = "/"
		}
	} else {
		var rootPath string
		if err := s.DB.QueryRow(`SELECT root_path FROM servers WHERE id = ? AND user_id = ?`,
			serverID, u.ID).Scan(&rootPath); err != nil {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
		if in.Path == "" {
			in.Path = rootPath
		}
	}
	if in.Path == "" || path.Clean(in.Path) != in.Path {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	if in.Kind == "" {
		s.DB.Exec(`DELETE FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, in.Path)
	} else {
		s.DB.Exec(`INSERT OR REPLACE INTO catalog_scopes (server_id, path, kind) VALUES (?, ?, ?)`,
			serverID, in.Path, in.Kind)
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleTmdbSearch backs the match dialog for tmdb-scoped folders.
// GET /api/tmdb/search?kind=tv|movie&q=
//
//	@Summary		Search TMDB
//	@Description	Search TMDB TV or movies by title for the match dialog.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			kind	query		string	true	"tv | movie"
//	@Param			q		query		string	true	"Search query"
//	@Success		200		{array}		anilist.Media
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/tmdb/search [get]
func (s *Server) handleTmdbSearch(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	if kind != "tv" && kind != "movie" {
		writeErr(w, http.StatusBadRequest, "kind must be tv or movie")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "q required")
		return
	}
	list, err := s.Tmdb.Search(r.Context(), kind, q, 0)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleTmdbMedia resolves one TMDB id (match dialog: pasted id or link).
// GET /api/tmdb/media?kind=tv|movie&id=123
//
//	@Summary		TMDB media
//	@Description	Resolve a single TMDB TV or movie entry by id.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			kind	query		string	true	"tv | movie"
//	@Param			id		query		int		true	"TMDB id"
//	@Success		200		{object}	anilist.Media
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/tmdb/media [get]
func (s *Server) handleTmdbMedia(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	if (kind != "tv" && kind != "movie") || id <= 0 {
		writeErr(w, http.StatusBadRequest, "kind and id required")
		return
	}
	m, err := s.Tmdb.Media(r.Context(), kind, id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

var yearRe = regexp.MustCompile(`\b(19|20)\d{2}\b`)

// queueTmdbMatch resolves one folder against TMDB in the background.
// No batching: TMDB's rate limit is generous and the client paces itself.
func (s *Server) queueTmdbMatch(serverID int64, folder, name, kind string, force bool) {
	s.runJob(fmt.Sprintf("m:%d:%s", serverID, folder), func(ctx context.Context) {
		query := GuessTitle(name)
		year := 0
		if y := yearRe.FindString(name); y != "" {
			year, _ = strconv.Atoi(y)
		}
		if force {
			s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`,
				fmt.Sprintf("tmdb:search:%s:%s|%d", kind, query, year))
		}
		list, err := s.Tmdb.Search(ctx, kind, query, year)
		if err != nil {
			return // retried by the next catalog poll
		}
		if len(list) == 0 && year != 0 {
			list, err = s.Tmdb.Search(ctx, kind, query, 0)
			if err != nil {
				return
			}
		}
		if len(list) == 0 && GuessAltTitle(name) != "" {
			list, err = s.Tmdb.Search(ctx, kind, GuessAltTitle(name), 0)
			if err != nil {
				return
			}
		}
		if nq := match.Normalize(query); len(list) == 0 && nq != normTitle(query) {
			list, err = s.Tmdb.Search(ctx, kind, nq, 0)
			if err != nil {
				return
			}
		}
		mediaID := 0
		if len(list) > 0 {
			mediaID = list[0].ID
		}
		if mediaID != 0 {
			s.Tmdb.Media(ctx, kind, mediaID) // full details into the cache first
		}
		s.persistMatch(serverID, folder, mediaID, false, "tmdb:"+kind)
	})
}

// queueTmdbFetch refreshes missing/stale TMDB media in the background.
func (s *Server) queueTmdbFetch(kind string, id int) {
	s.runJob(fmt.Sprintf("tf:%s:%d", kind, id), func(ctx context.Context) {
		s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`, fmt.Sprintf("tmdb:media:%s:%d", kind, id))
		s.Tmdb.Media(ctx, kind, id)
	})
}

// sourceMedia loads cached media for a match row of any source, queueing a
// background refresh for missing/stale non-finished entries.
func (s *Server) sourceMedia(source string, id int) (m *anilist.Media, pending bool) {
	var fresh bool
	switch {
	case source == "anilist":
		m, fresh = s.Anilist.CachedMedia(id)
		if m == nil {
			s.queueMediaFetch(id)
			return nil, true
		}
		if !fresh && m.Status != "FINISHED" && m.Status != "CANCELLED" {
			s.queueMediaFetch(id)
		}
	case strings.HasPrefix(source, "tmdb:"):
		kind := strings.TrimPrefix(source, "tmdb:")
		m, fresh = s.Tmdb.CachedMedia(kind, id)
		if m == nil {
			s.queueTmdbFetch(kind, id)
			return nil, true
		}
		if !fresh && m.Status != "FINISHED" && m.Status != "CANCELLED" {
			s.queueTmdbFetch(kind, id)
		}
	case source == "tvdb":
		m, fresh = s.Tvdb.CachedMedia(id)
		if m == nil {
			s.queueTvdbFetch(id)
			return nil, true
		}
		if !fresh && m.Status != "FINISHED" && m.Status != "CANCELLED" {
			s.queueTvdbFetch(id)
		}
	}
	if m != nil {
		m.Title.Preferred = displayTitle(*m, source) // canonical localized display title
	}
	return m, false
}
