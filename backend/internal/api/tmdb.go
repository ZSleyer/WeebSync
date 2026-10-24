package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/tmdb"
)

// Folder scopes: a folder marked 'tv' or 'movie' switches catalog matching
// for the folders directly inside it from AniList (anime, the default) to TMDB.

// scopeFor returns the scope kind (”, 'tv', 'movie') marked on a path. Marks
// do not reach into subfolders: a catalog view describes the folder it was
// chosen for, and a level deeper is usually a different kind of listing
// (seasons, versions) that should not be matched as titles again.
//
// The one exception is an alphabet shelf: "Manga/M/Monster" files its titles
// under a letter folder, and that folder takes the mark of the one above it.
// A folder without a mark of its own can get one from a scope rule on its
// parent (scope_rules.go); a stored "none" keeps a rule off one folder.
func (s *Server) scopeFor(serverID int64, p string) string {
	var kind string
	err := s.DB.QueryRow(`SELECT kind FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, p).Scan(&kind)
	switch {
	case err == nil:
	case isShelf(path.Base(p)) && path.Dir(p) != p:
		kind = s.scopeFor(serverID, path.Dir(p))
	default:
		_, kind = s.ruleScope(serverID, p)
	}
	if kind == scopeNone {
		return ""
	}
	return kind
}

// shelfRe matches an alphabet shelf folder: one letter, or the bucket the
// digits and symbols are sorted into.
var shelfRe = regexp.MustCompile(`^(?:[A-Za-z]|0-9|#|[0-9]|-)$`)

// isShelf reports whether a folder name is an alphabet shelf, not a title.
func isShelf(name string) bool { return shelfRe.MatchString(name) }

// isHelperDir reports whether a folder is one a tool keeps next to the titles
// (Plex's optimized versions, a NAS thumbnail cache, a hidden folder such as
// the upgrade trash) rather than a title to match.
func isHelperDir(name string) bool {
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "@") || strings.EqualFold(name, "Plex Versions")
}

// scopeResponse reports the metadata scope of a catalog path.
type scopeResponse struct {
	Scope string `json:"scope"` // "" | anime | manga | tv | movie | tvdb | auto
	// the name shape a rule made from this folder would cover; "" when its
	// name has nothing that varies (no number, no season) or it is the root
	RuleShape string `json:"ruleShape"`
	// the rule that covers this folder (its parent and shape), 0 for none.
	// Scope came from it unless the folder carries a mark of its own.
	RuleID   int64  `json:"ruleId"`
	RuleKind string `json:"ruleKind"`
	// the folder's own mark was set by WeebSync, not by a user (detected.go);
	// changing or clearing it stores the user's decision
	Detected bool `json:"detected"`
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
//	@Failure		500		{object}	ErrorResponse
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
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
		dbErr(w, err)
		return
	}
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = rootPath
	}
	out := scopeResponse{Scope: s.scopeFor(serverID, dir)}
	detectedAt, err := s.detectedAt(serverID, dir)
	if err != nil {
		dbErr(w, err)
		return
	}
	out.Detected = detectedAt > 0
	if path.Dir(dir) != dir {
		if shape := folderShape(path.Base(dir)); shapeVaries(shape) {
			out.RuleShape = shape
		}
		out.RuleID, out.RuleKind = s.ruleScope(serverID, dir)
	}
	writeJSON(w, http.StatusOK, out)
}

// mangaSource is the catalog_matches source of a folder matched against
// AniList's MANGA catalogue. Plain "anilist" stays anime: the anime-only passes
// (season identity, relations, dubs, the anime id mapping) never see a manga.
const mangaSource = "anilist:manga"

// sourceForScope maps a scope kind to the catalog_matches source tag.
// 'anime' is an explicit override mark below a TMDB/TVDB-scoped folder.
func sourceForScope(kind string) string {
	switch kind {
	case "", "anime", scopeAuto:
		// an automatic mark names no provider of its own (expectedSource
		// reads it off the match); AniList is where a folder starts
		return "anilist"
	case "manga":
		return mangaSource
	case "tvdb", tvdbMovieSource:
		return kind
	default:
		return "tmdb:" + kind // tv | movie
	}
}

// scopeRequest is the body of handleCatalogScope.
type scopeRequest struct {
	Path string `json:"path"`
	// "" clears the mark; "none" stores "no mark", which keeps a scope rule
	// and the hints off this folder
	Kind string `json:"kind"` // "" | none | anime | manga | tv | movie | tvdb | auto
	// also mark new folders beside this one whose name has the same shape
	// (numbers and season names vary); needs a kind and a name that varies
	Rule bool `json:"rule,omitempty"`
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
//	@Success		200		{object}	scopeSetResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/scope [put]
func (s *Server) handleCatalogScope(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	if localCurateDenied(w, u, serverID) {
		return
	}
	var in scopeRequest
	if !readJSON(w, r, &in) {
		return
	}
	switch in.Kind {
	case "", scopeNone, scopeAuto, "anime", "manga", "tv", "movie", "tvdb":
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
			if errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "server not found")
				return
			}
			dbErr(w, err)
			return
		}
		if in.Path == "" {
			in.Path = rootPath
		}
	}
	if len(in.Path) > 1 {
		in.Path = strings.TrimSuffix(in.Path, "/") // "/plex/Serien/" names the same folder
	}
	if in.Path == "" || path.Clean(in.Path) != in.Path {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	shape := folderShape(path.Base(in.Path))
	if in.Rule && (in.Kind == "" || in.Kind == scopeNone || path.Dir(in.Path) == in.Path || !shapeVaries(shape)) {
		writeErr(w, http.StatusBadRequest, "no rule possible for this folder")
		return
	}
	ruleID, _ := s.ruleScope(serverID, in.Path)
	// a mark WeebSync detected is replaced by the user's row (detected_at back
	// to 0), and clearing it stores "none": a deleted row would be detected
	// again at the next sweep
	detectedAt, err := s.detectedAt(serverID, in.Path)
	if err != nil {
		dbErr(w, err)
		return
	}
	switch {
	case in.Kind != "":
		_, err = s.DB.Exec(`INSERT OR REPLACE INTO catalog_scopes (server_id, path, kind) VALUES (?, ?, ?)`,
			serverID, in.Path, in.Kind)
	case ruleID != 0 || detectedAt > 0:
		// clearing a folder a rule covers: without a stored "none" the rule
		// would mark it again at once
		_, err = s.DB.Exec(`INSERT OR REPLACE INTO catalog_scopes (server_id, path, kind) VALUES (?, ?, ?)`,
			serverID, in.Path, scopeNone)
	default:
		_, err = s.DB.Exec(`DELETE FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, in.Path)
	}
	if err == nil && in.Rule {
		_, err = s.DB.Exec(`INSERT INTO catalog_scope_rules (server_id, parent, shape, kind) VALUES (?, ?, ?, ?)
			ON CONFLICT (server_id, parent, shape) DO UPDATE SET kind = excluded.kind`,
			serverID, path.Dir(in.Path), shape, in.Kind)
	}
	if err != nil {
		dbErr(w, err)
		return
	}
	// the folders under a new mark are matched now, not on the next sweep
	queued := 0
	if in.Kind != "" && in.Kind != scopeNone {
		queued = s.queueScopeChildren(serverID, in.Path, in.Kind)
		_, rematched := s.clearStaleSubRows(serverID, in.Path, in.Kind)
		queued += rematched
	}
	writeJSON(w, http.StatusOK, scopeSetResponse{Status: "ok", Queued: queued})
}

// clearStaleSubRows drops the empty rows of another source further down a
// marked folder - a season folder listed once before the mark is no match,
// only a stale "none found". A watch's folder keeps its row: matchWatch moves
// an automatic match of another source over, and no other pass reaches a
// watch below the folders the mark lists (a watched season folder), so it is
// asked here. A manual match stays. Reports the rows dropped and the watches
// queued.
func (s *Server) clearStaleSubRows(serverID int64, dir, kind string) (cleared int64, rematched int) {
	res, err := s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ?1 AND manual = 0 AND media_id = 0 AND source != ?3
		AND folder >= ?2 || '/' AND folder < ?2 || '0' AND instr(substr(folder, length(?2) + 2), '/') > 0
		AND folder NOT IN (SELECT remote_path FROM watches WHERE server_id = ?1)`,
		serverID, dir, sourceForScope(kind))
	if err != nil {
		return 0, 0
	}
	cleared, _ = res.RowsAffected()
	rows, err := s.DB.Query(`SELECT remote_path, local_path FROM watches WHERE server_id = ?1
		AND remote_path >= ?2 || '/' AND remote_path < ?2 || '0' AND instr(substr(remote_path, length(?2) + 2), '/') > 0`,
		serverID, dir)
	if err != nil {
		return cleared, 0
	}
	defer rows.Close()
	type watchFolder struct{ remote, local string }
	var watched []watchFolder
	for rows.Next() {
		var w watchFolder
		if rows.Scan(&w.remote, &w.local) == nil {
			watched = append(watched, w)
		}
	}
	if rows.Err() != nil {
		return cleared, 0
	}
	for _, w := range watched {
		if s.matchWatch(serverID, w.remote, w.local, false) {
			rematched++
		}
	}
	return cleared, rematched
}

// catalogRepairs names the one-time fixes of stored state below; bumping it
// runs them once more.
const catalogRepairs = "2026-10-plex-by-tvdb-id"

// RepairCatalog runs once per catalogRepairs, at startup:
//
//   - the stale rows under every mark set before marks cleared them
//     (clearStaleSubRows ran only on setting a mark), and the watched season
//     folders under a mark that kept the match of another source
//   - Plex's ids hung on the series again: the leftover rule dropped ids Plex
//     had attached where the anime mapping is wrong, a show Plex names or
//     dates differently is now found by its TVDB id, and the reconcile pass
//     only revisits folders it has not checked yet
func (s *Server) RepairCatalog() {
	if db.Setting(s.DB, "catalog_repairs") == catalogRepairs {
		return
	}
	rows, err := s.DB.Query(`SELECT server_id, path, kind FROM catalog_scopes WHERE kind != ?`, scopeNone)
	if err != nil {
		return
	}
	defer rows.Close()
	type mark struct {
		server     int64
		path, kind string
	}
	var marks []mark
	for rows.Next() {
		var m mark
		if rows.Scan(&m.server, &m.path, &m.kind) == nil {
			marks = append(marks, m)
		}
	}
	if rows.Err() != nil {
		return
	}
	var cleared int64
	rematched := 0
	for _, m := range marks {
		c, r := s.clearStaleSubRows(m.server, m.path, m.kind)
		cleared += c
		rematched += r
	}
	if _, err := s.DB.Exec(`DELETE FROM plex_reconciled`); err != nil {
		return
	}
	slog.Info("catalog repaired", "staleRows", cleared, "watchesRematched", rematched, "marks", len(marks))
	if err := db.SetSetting(s.DB, "catalog_repairs", catalogRepairs); err != nil {
		slog.Warn("catalog repair not recorded", "err", err)
	}
}

// providerRecords names how TVDB and TMDB records are cached; bumping it
// drops the cached ones once so they are fetched again in the new shape.
const providerRecords = "2026-10-overviews-de-en"

// RefreshProviderRecords drops the cached TVDB and TMDB records once per
// providerRecords. Those cached before carry one overview - TVDB's in the
// show's own language, Japanese for an anime, TMDB's in German for every
// reader - where they now carry German and English, and a finished show is
// never fetched again by itself. They come back as they are needed.
func (s *Server) RefreshProviderRecords() {
	if db.Setting(s.DB, "provider_records") == providerRecords {
		return
	}
	res, err := s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'tvdb:media:%' OR key LIKE 'tvdb:movie:media:%' OR key LIKE 'tmdb:media:%'`)
	if err != nil {
		return
	}
	n, _ := res.RowsAffected()
	slog.Info("provider records dropped for a fresh fetch", "records", n)
	if err := db.SetSetting(s.DB, "provider_records", providerRecords); err != nil {
		slog.Warn("provider records drop not recorded", "err", err)
	}
}

// scopeSetResponse confirms a mark; Queued counts the folders under it sent
// to be matched on the mark's source.
type scopeSetResponse struct {
	Status string `json:"status" example:"ok"`
	Queued int    `json:"queued"`
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
		mediaID, _, err := s.tmdbLookup(ctx, serverID, folder, name, kind, force)
		if err != nil {
			return // retried by the next catalog poll
		}
		// persistMatch logs a failure; the next catalog poll retries
		_ = s.persistMatch(serverID, folder, mediaID, false, "tmdb:"+kind)
	})
}

// tmdbLookup finds the TMDB entry of kind (tv | movie) a folder names, 0 when
// none carries one of the folder's names. An error means the search itself
// failed: nothing is known, nothing should be stored. The search result the
// entry was found as comes with it (nil for what Plex identified).
func (s *Server) tmdbLookup(ctx context.Context, serverID int64, folder, name, kind string, force bool) (int, *anilist.Media, error) {
	// what Plex identified under this name and year wins over a search
	mediaID, _ := s.matchLocalByPlexID(folder, "tmdb:"+kind)
	var hit *anilist.Media
	year, _ := strconv.Atoi(yearRe.FindString(name))
	for _, lq := range s.liveQueries(serverID, folder, name) {
		if mediaID != 0 {
			break
		}
		var list []anilist.Media
		for _, y := range []int{year, 0} {
			if y == 0 && year != 0 && len(list) > 0 {
				break // the year search answered; without it only strangers join
			}
			if force {
				// a stale entry that stays only costs the refresh
				_, _ = s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`,
					tmdb.SearchCacheKey(kind, lq.q, y))
			}
			l, err := s.Tmdb.Search(ctx, kind, lq.q, y)
			if err != nil {
				return 0, nil, err
			}
			list = append(list, l...)
			if year == 0 {
				break
			}
		}
		// the localized name and the original, as the adapter maps them
		cands := make([]liveCand, 0, len(list))
		for _, m := range list {
			titles := []string{m.Title.Romaji, m.Title.English}
			// an anime is also known by its AniList titles
			alias := s.animeTitles(kind, m.ID)
			cands = append(cands, liveCand{id: m.ID, year: m.SeasonYear, titles: append(titles, alias...), anime: len(alias) > 0 || s.inAnimeIDs("tmdb:"+kind, m.ID), media: m})
		}
		if c, ok := pickLiveCand(name, lq.accept, cands); ok {
			mediaID, hit = c.id, &c.media
		}
	}
	if mediaID != 0 {
		s.Tmdb.Media(ctx, kind, mediaID) // full details into the cache first
	}
	return mediaID, hit, nil
}

// queueTmdbFetch refreshes missing/stale TMDB media in the background.
func (s *Server) queueTmdbFetch(kind string, id int) {
	s.runJob(fmt.Sprintf("tf:%s:%d", kind, id), func(ctx context.Context) {
		s.refetchCached(fmt.Sprintf("tmdb:media:%s:%d", kind, id), func() error {
			_, err := s.Tmdb.Media(ctx, kind, id)
			return err
		})
	})
}

// sourceMedia loads cached media for a match row of any source, queueing a
// background refresh for missing/stale non-finished entries.
func (s *Server) sourceMedia(source string, id int) (m *anilist.Media, pending bool) {
	var fresh bool
	// a payload written before the current field set is refetched regardless of
	// TTL and status: a finished title never expires otherwise, so entries
	// cached earlier would never gain the popularity/studio/date sort keys
	outdated := func(m *anilist.Media) bool {
		if m.Schema < anilist.MediaSchema {
			return true
		}
		return !fresh && m.Status != "FINISHED" && m.Status != "CANCELLED"
	}
	switch {
	case source == "anilist" || source == mangaSource:
		m, fresh = s.Anilist.CachedMedia(id)
		if m == nil {
			s.queueMediaFetch(id)
			return nil, true
		}
		if outdated(m) {
			s.queueMediaFetch(id)
		}
		// a manga counts volumes where an anime counts episodes: one number
		// for completeness and the overview, labelled by the watch category
		if source == mangaSource && m.Episodes == 0 {
			m.Episodes = m.Volumes
		}
	case strings.HasPrefix(source, "tmdb:"):
		if s.Tmdb == nil {
			return nil, false
		}
		kind := strings.TrimPrefix(source, "tmdb:")
		m, fresh = s.Tmdb.CachedMedia(kind, id)
		if m == nil {
			s.queueTmdbFetch(kind, id)
			return nil, true
		}
		if outdated(m) {
			s.queueTmdbFetch(kind, id)
		}
	case source == "tvdb":
		if s.Tvdb == nil {
			return nil, false
		}
		m, fresh = s.Tvdb.CachedMedia(id)
		if m == nil {
			s.queueTvdbFetch(id)
			return nil, true
		}
		// a stale record from before the extended fetch (no genres) is
		// fetched again even when finished: it lacks the airing data
		if outdated(m) || (!fresh && m.Genres == nil) {
			s.queueTvdbFetch(id)
		}
	case source == tvdbMovieSource:
		if s.Tvdb == nil {
			return nil, false
		}
		m, fresh = s.Tvdb.CachedMovie(id)
		if m == nil {
			s.queueTvdbMovieFetch(id)
			return nil, true
		}
		if outdated(m) {
			s.queueTvdbMovieFetch(id)
		}
	}
	if m != nil {
		m.Title.Preferred = displayTitle(*m, source) // canonical localized display title
	}
	return m, false
}
