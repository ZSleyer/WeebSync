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
)

// Folder scopes: a folder marked 'tv' or 'movie' switches catalog matching
// for everything below it from AniList (anime, the default) to TMDB.

// scopeFor returns the effective scope kind (”, 'tv', 'movie') for a path:
// the mark of the deepest marked ancestor (or the path itself).
func (s *Server) scopeFor(serverID int64, p string) string {
	var kind string
	s.DB.QueryRow(`SELECT kind FROM catalog_scopes
		WHERE server_id = ? AND (path = ? OR ? LIKE path || '/%')
		ORDER BY length(path) DESC LIMIT 1`, serverID, p, p).Scan(&kind)
	return kind
}

// sourceForScope maps a scope kind to the catalog_matches source tag.
// 'anime' is an explicit override mark below a TMDB-scoped folder.
func sourceForScope(kind string) string {
	if kind == "" || kind == "anime" {
		return "anilist"
	}
	return "tmdb:" + kind
}

// handleCatalogScope sets or clears a folder mark.
// PUT /api/servers/{id}/catalog/scope {path, kind: ”|'tv'|'movie'}
func (s *Server) handleCatalogScope(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var in struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	switch in.Kind {
	case "", "anime", "tv", "movie":
	default:
		writeErr(w, http.StatusBadRequest, "invalid kind")
		return
	}
	if (in.Kind == "tv" || in.Kind == "movie") && !s.Tmdb.Enabled() {
		writeErr(w, http.StatusBadRequest, "TMDB API key required")
		return
	}
	// ownership check doubles as root path lookup (empty path = root)
	var rootPath string
	if err := s.DB.QueryRow(`SELECT root_path FROM servers WHERE id = ? AND user_id = ?`,
		serverID, u.ID).Scan(&rootPath); err != nil {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	if in.Path == "" {
		in.Path = rootPath
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleTmdbSearch backs the match dialog for tmdb-scoped folders.
// GET /api/tmdb/search?kind=tv|movie&q=
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
		mediaID := 0
		if len(list) > 0 {
			mediaID = list[0].ID
		}
		s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, 0, ?)`,
			serverID, folder, mediaID, "tmdb:"+kind)
		if mediaID != 0 {
			s.Tmdb.Media(ctx, kind, mediaID) // full details into the cache
		}
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
	}
	return m, false
}
