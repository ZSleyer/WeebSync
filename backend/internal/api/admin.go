package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// Admin job/cache introspection and triggers: one status endpoint for the
// background machinery (match queue, caches, crawler, watches) plus manual
// job runs and cache flushes. All routes are admin-only and cross-user by
// design - caches and the remote index are shared infrastructure.

// cacheScopes maps the public scope names to their key prefix in the shared
// anilist_cache KV table and the TTL the owning client applies on reads -
// the default, made configurable by the given settings key ("" = fixed).
// "tmdb:coll" covers both tmdb:coll-of:<movie> and tmdb:collection:<id>.
type cacheScope struct {
	name    string
	prefix  string
	setting string
	ttl     time.Duration
}

var cacheScopes = []cacheScope{
	{"anilist-search", "search:", "ttl_anilist_h", 24 * time.Hour},
	{"anilist-media", "media:", "ttl_anilist_h", 24 * time.Hour},
	{"anilist-relations", "rel2:", "ttl_anilist_h", 24 * time.Hour},
	{"anilist-userlist", "alist:", "", time.Hour},
	{"tmdb-search", "tmdb:search:", "ttl_tmdb_h", 24 * time.Hour},
	{"tmdb-media", "tmdb:media:", "ttl_tmdb_h", 24 * time.Hour},
	{"tmdb-collections", "tmdb:coll", "ttl_tmdb_h", 24 * time.Hour},
	{"plex", "plex:", "ttl_plex_h", 6 * time.Hour},
}

func cacheScopeFor(name string) (cacheScope, bool) {
	for _, sc := range cacheScopes {
		if sc.name == name {
			return sc, true
		}
	}
	return cacheScope{}, false
}

// ttlSetting reads an hours setting, falling back to def when unset/zero.
func (s *Server) ttlSetting(key string, def time.Duration) time.Duration {
	if h, _ := strconv.Atoi(db.Setting(s.DB, key)); h > 0 {
		return time.Duration(h) * time.Hour
	}
	return def
}

// scopeTTL is a scope's effective TTL with the admin override applied.
func (s *Server) scopeTTL(sc cacheScope) time.Duration {
	if sc.setting == "" {
		return sc.ttl
	}
	return s.ttlSetting(sc.setting, sc.ttl)
}

// escapeLike escapes LIKE wildcards so user input matches literally
// (queries using it must carry ESCAPE '\').
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// pageParams reads offset/limit query parameters (limit default 50, cap 200).
func pageParams(r *http.Request) (offset, limit int) {
	offset, _ = strconv.Atoi(r.URL.Query().Get("offset"))
	if offset < 0 {
		offset = 0
	}
	limit, _ = strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	return
}

// jobsSnapshot returns the currently running background jobs: the queued
// per-folder match jobs ("m:...") collapsed into a count, everything else
// by key (capped, sorted for stable output).
func (s *Server) jobsSnapshot() (keys []string, matchQueue int) {
	s.matchMu.Lock()
	defer s.matchMu.Unlock()
	for k := range s.matchJobs {
		if strings.HasPrefix(k, "m:") {
			matchQueue++
		} else {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > 20 {
		keys = keys[:20]
	}
	return
}

type adminCacheStat struct {
	Scope  string `json:"scope"`
	Count  int    `json:"count"`
	Oldest string `json:"oldest"`
	Newest string `json:"newest"`
	TTLSec int    `json:"ttlSec"`
	Stale  int    `json:"stale"` // rows older than the scope's TTL
}

type adminIndexServer struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Rows            int    `json:"rows"`
	Dirs            int    `json:"dirs"`
	PendingDirs     int    `json:"pendingDirs"` // known but never listed
	StalestListedAt string `json:"stalestListedAt"`
	IntervalMin     int    `json:"intervalMin"` // effective crawl interval
	Batch           int    `json:"batch"`       // effective listings per crawl
}

type adminMatchStat struct {
	ServerID  int64  `json:"serverId"`
	Name      string `json:"name"`
	Source    string `json:"source"`
	Total     int    `json:"total"`
	Matched   int    `json:"matched"`
	Unmatched int    `json:"unmatched"` // automatic "no match" rows
	Manual    int    `json:"manual"`
}

type adminJobsResponse struct {
	Running    []string         `json:"running"`
	MatchQueue int              `json:"matchQueue"`
	Caches     []adminCacheStat `json:"caches"`
	TTL        adminTTLInfo     `json:"ttl"`
	Plex       adminPlexInfo    `json:"plex"`
	Anilist    adminAnilistInfo `json:"anilist"`
	Index      adminIndexInfo   `json:"index"`
	Watch      adminWatchInfo   `json:"watch"`
	Matches    []adminMatchStat `json:"matches"`
}

// adminTTLInfo reports the effective cache TTLs in hours.
type adminTTLInfo struct {
	AnilistH int `json:"anilistH"`
	TmdbH    int `json:"tmdbH"`
	PlexH    int `json:"plexH"`
}

type adminPlexInfo struct {
	Configured    bool   `json:"configured"`
	SuggestionsAt string `json:"suggestionsAt"`
	TTLSec        int    `json:"ttlSec"`
}

type adminAnilistInfo struct {
	Accounts int `json:"accounts"`
}

type adminIndexInfo struct {
	TickSec    int                `json:"tickSec"`
	RecheckSec int                `json:"recheckSec"`
	Servers    []adminIndexServer `json:"servers"`
}

type adminWatchInfo struct {
	IntervalMin int `json:"intervalMin"`
	Count       int `json:"count"`
}

// handleAdminJobs reports the state of all background machinery.
func (s *Server) handleAdminJobs(w http.ResponseWriter, r *http.Request) {
	out := adminJobsResponse{
		Running: []string{},
		Caches:  []adminCacheStat{},
		Index: adminIndexInfo{
			TickSec:    int(crawlTick / time.Second),
			RecheckSec: int(crawlRecheck / time.Second),
			Servers:    []adminIndexServer{},
		},
		Matches: []adminMatchStat{},
	}
	running, matchQueue := s.jobsSnapshot()
	out.Running = append(out.Running, running...)
	out.MatchQueue = matchQueue

	for _, sc := range cacheScopes {
		ttl := s.scopeTTL(sc)
		st := adminCacheStat{Scope: sc.name, TTLSec: int(ttl / time.Second)}
		s.DB.QueryRow(`SELECT COUNT(*), COALESCE(MIN(fetched_at),''), COALESCE(MAX(fetched_at),''),
			COALESCE(SUM(datetime(fetched_at) <= datetime('now', ?)),0)
			FROM anilist_cache WHERE key LIKE ? || '%'`,
			fmt.Sprintf("-%d seconds", int(ttl/time.Second)), sc.prefix).
			Scan(&st.Count, &st.Oldest, &st.Newest, &st.Stale)
		out.Caches = append(out.Caches, st)
	}
	out.TTL = adminTTLInfo{
		AnilistH: int(s.ttlSetting("ttl_anilist_h", 24*time.Hour) / time.Hour),
		TmdbH:    int(s.ttlSetting("ttl_tmdb_h", 24*time.Hour) / time.Hour),
		PlexH:    int(s.plexSuggestTTL() / time.Hour),
	}

	out.Plex = adminPlexInfo{Configured: s.plexClient() != nil, TTLSec: int(s.plexSuggestTTL() / time.Second)}
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = 'plex:suggestions:v2'`).Scan(&out.Plex.SuggestionsAt)

	s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_accounts`).Scan(&out.Anilist.Accounts)

	rows, err := s.DB.Query(`SELECT s.id, s.name, COUNT(i.path), COALESCE(SUM(i.is_dir),0),
		COALESCE(SUM(i.is_dir = 1 AND i.listed_at = ''),0),
		COALESCE(MIN(CASE WHEN i.is_dir = 1 AND i.listed_at != '' THEN i.listed_at END),'')
		FROM servers s LEFT JOIN remote_index i ON i.server_id = s.id
		GROUP BY s.id ORDER BY s.id`)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var v adminIndexServer
		rows.Scan(&v.ID, &v.Name, &v.Rows, &v.Dirs, &v.PendingDirs, &v.StalestListedAt)
		out.Index.Servers = append(out.Index.Servers, v)
	}
	rows.Close()
	for i := range out.Index.Servers {
		v := &out.Index.Servers[i]
		v.IntervalMin = int(s.crawlIntervalFor(v.ID) / time.Minute)
		v.Batch = s.crawlBatchFor(v.ID)
	}

	out.Watch.IntervalMin = s.watchInterval()
	s.DB.QueryRow(`SELECT COUNT(*) FROM watches`).Scan(&out.Watch.Count)

	rows, err = s.DB.Query(`SELECT m.server_id, s.name, m.source, COUNT(*),
		SUM(m.media_id != 0), SUM(m.media_id = 0 AND m.manual = 0), SUM(m.manual)
		FROM catalog_matches m JOIN servers s ON s.id = m.server_id
		GROUP BY m.server_id, m.source ORDER BY m.server_id, m.source`)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var v adminMatchStat
		rows.Scan(&v.ServerID, &v.Name, &v.Source, &v.Total, &v.Matched, &v.Unmatched, &v.Manual)
		out.Matches = append(out.Matches, v)
	}
	rows.Close()

	writeJSON(w, http.StatusOK, out)
}

// handleAdminJobRun triggers one background job by name.
// POST /api/admin/jobs/{name}/run {serverId?, all?}
func (s *Server) handleAdminJobRun(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ServerID int64 `json:"serverId"`
		All      bool  `json:"all"`
	}
	if r.ContentLength > 0 && !readJSON(w, r, &in) {
		return
	}
	switch r.PathValue("name") {
	case "plex-suggestions":
		s.runJob("plex:suggest", func(ctx context.Context) { s.buildPlexSuggestions(ctx) })
		writeJSON(w, http.StatusOK, map[string]string{"status": "started"})

	case "anilist-suggestions":
		// force-refresh every linked account's watchlist cache
		rows, err := s.DB.Query(`SELECT anilist_user_id, token_enc FROM anilist_accounts`)
		if err != nil {
			dbErr(w)
			return
		}
		type account struct {
			alID  int
			token string
		}
		var accounts []account
		for rows.Next() {
			var alID int
			var enc []byte
			rows.Scan(&alID, &enc)
			token, err := secret.Decrypt(enc)
			if err != nil {
				continue
			}
			accounts = append(accounts, account{alID, token})
		}
		rows.Close()
		for _, a := range accounts {
			s.Anilist.InvalidateUserList(a.alID)
			s.buildAnilistSuggestions(a.alID, a.token)
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "started"})

	case "index-crawl":
		if in.ServerID == 0 {
			writeErr(w, http.StatusBadRequest, "serverId required")
			return
		}
		var userID int64
		var root string
		if err := s.DB.QueryRow(`SELECT user_id, root_path FROM servers WHERE id = ?`, in.ServerID).
			Scan(&userID, &root); err != nil {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
		// one batch with the server's configured budget; the manual trigger
		// ignores the crawl interval by design
		s.runJob(fmt.Sprintf("crawl:%d", in.ServerID), func(ctx context.Context) {
			s.crawlServer(ctx, userID, in.ServerID, root, s.crawlBatchFor(in.ServerID))
		})
		writeJSON(w, http.StatusOK, map[string]string{"status": "started"})

	case "rematch":
		// server-wide variant of handleCatalogRematch: re-queue automatic
		// matches with a forced search - by default only "no match" rows,
		// with all=true every automatic match. Manual rows are left alone.
		if in.ServerID == 0 {
			writeErr(w, http.StatusBadRequest, "serverId required")
			return
		}
		cond := "AND media_id = 0"
		if in.All {
			cond = ""
		}
		rows, err := s.DB.Query(`SELECT folder, source FROM catalog_matches
			WHERE server_id = ? AND manual = 0 `+cond, in.ServerID)
		if err != nil {
			dbErr(w)
			return
		}
		type match struct{ folder, source string }
		var matches []match
		for rows.Next() {
			var m match
			rows.Scan(&m.folder, &m.source)
			matches = append(matches, m)
		}
		rows.Close()
		for _, m := range matches {
			switch m.source {
			case "tmdb:tv", "tmdb:movie":
				s.queueTmdbMatch(in.ServerID, m.folder, path.Base(m.folder), strings.TrimPrefix(m.source, "tmdb:"), true)
			default: // anilist
				s.queueMatch(in.ServerID, m.folder, path.Base(m.folder), true)
			}
			// drop the row so the catalog shows these as pending while the
			// forced search runs (same semantics as handleCatalogRematch)
			s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ? AND folder = ? AND manual = 0`,
				in.ServerID, m.folder)
		}
		writeJSON(w, http.StatusOK, map[string]int{"queued": len(matches)})

	default:
		writeErr(w, http.StatusNotFound, "unknown job")
	}
}

// handleAdminCacheFlush deletes all cache rows of one scope.
// DELETE /api/admin/cache/{scope}
func (s *Server) handleAdminCacheFlush(w http.ResponseWriter, r *http.Request) {
	sc, ok := cacheScopeFor(r.PathValue("scope"))
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown scope")
		return
	}
	res, err := s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE ? || '%'`, sc.prefix)
	if err != nil {
		dbErr(w)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}

type adminCacheEntry struct {
	Key       string `json:"key"`
	FetchedAt string `json:"fetchedAt"`
	Stale     bool   `json:"stale"`
	Bytes     int    `json:"bytes"`
}

// handleAdminCacheEntries pages through the cache rows of one scope.
// GET /api/admin/cache/{scope}/entries?q=&offset=&limit=
func (s *Server) handleAdminCacheEntries(w http.ResponseWriter, r *http.Request) {
	sc, ok := cacheScopeFor(r.PathValue("scope"))
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown scope")
		return
	}
	offset, limit := pageParams(r)
	where := `key LIKE ? || '%'`
	args := []any{sc.prefix}
	if q := r.URL.Query().Get("q"); q != "" {
		where += ` AND key LIKE '%' || ? || '%' ESCAPE '\'`
		args = append(args, escapeLike(q))
	}
	total := 0
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM anilist_cache WHERE `+where, args...).Scan(&total); err != nil {
		dbErr(w)
		return
	}
	rows, err := s.DB.Query(`SELECT key, fetched_at, LENGTH(payload),
		COALESCE(datetime(fetched_at) <= datetime('now', ?), 0)
		FROM anilist_cache WHERE `+where+` ORDER BY fetched_at DESC LIMIT ? OFFSET ?`,
		append([]any{fmt.Sprintf("-%d seconds", int(s.scopeTTL(sc)/time.Second))}, append(args, limit, offset)...)...)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	entries := []adminCacheEntry{}
	for rows.Next() {
		var e adminCacheEntry
		rows.Scan(&e.Key, &e.FetchedAt, &e.Bytes, &e.Stale)
		entries = append(entries, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "entries": entries})
}

// handleAdminCacheEntryDelete deletes exactly one cache row. The key must
// carry the scope's prefix so a scoped delete cannot remove foreign keys.
// DELETE /api/admin/cache/{scope}/entries?key=<full key>
func (s *Server) handleAdminCacheEntryDelete(w http.ResponseWriter, r *http.Request) {
	sc, ok := cacheScopeFor(r.PathValue("scope"))
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown scope")
		return
	}
	key := r.URL.Query().Get("key")
	if key == "" || !strings.HasPrefix(key, sc.prefix) {
		writeErr(w, http.StatusBadRequest, "key must match the scope prefix")
		return
	}
	res, err := s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`, key)
	if err != nil {
		dbErr(w)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}

type adminMatchEntry struct {
	Folder  string `json:"folder"`
	MediaID int    `json:"mediaId"`
	Manual  bool   `json:"manual"`
	Source  string `json:"source"`
	Title   string `json:"title"` // from the media cache, "" when unresolved
}

// cachedTitle resolves a match row's display title from the media cache
// (stale entries included - this is display only). "" when nothing cached.
func (s *Server) cachedTitle(source string, mediaID int) string {
	if mediaID == 0 {
		return ""
	}
	key := fmt.Sprintf("media:%d", mediaID)
	if kind, ok := strings.CutPrefix(source, "tmdb:"); ok {
		key = fmt.Sprintf("tmdb:media:%s:%d", kind, mediaID)
	}
	var payload string
	if err := s.DB.QueryRow(`SELECT payload FROM anilist_cache WHERE key = ?`, key).Scan(&payload); err != nil {
		return ""
	}
	var m struct {
		Title struct {
			Romaji  string `json:"romaji"`
			English string `json:"english"`
		} `json:"title"`
	}
	if json.Unmarshal([]byte(payload), &m) != nil {
		return ""
	}
	if m.Title.Romaji != "" {
		return m.Title.Romaji
	}
	return m.Title.English
}

// handleAdminMatches pages through one server's catalog match rows.
// GET /api/admin/matches?serverId=&filter=all|matched|unmatched|manual&q=&offset=&limit=
func (s *Server) handleAdminMatches(w http.ResponseWriter, r *http.Request) {
	serverID, _ := strconv.ParseInt(r.URL.Query().Get("serverId"), 10, 64)
	if serverID == 0 {
		writeErr(w, http.StatusBadRequest, "serverId required")
		return
	}
	where := `server_id = ?`
	args := []any{serverID}
	switch r.URL.Query().Get("filter") {
	case "", "all":
	case "matched":
		where += ` AND media_id != 0`
	case "unmatched":
		where += ` AND media_id = 0 AND manual = 0`
	case "manual":
		where += ` AND manual = 1`
	default:
		writeErr(w, http.StatusBadRequest, "invalid filter")
		return
	}
	if q := r.URL.Query().Get("q"); q != "" {
		where += ` AND folder LIKE '%' || ? || '%' ESCAPE '\'`
		args = append(args, escapeLike(q))
	}
	offset, limit := pageParams(r)
	total := 0
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE `+where, args...).Scan(&total); err != nil {
		dbErr(w)
		return
	}
	rows, err := s.DB.Query(`SELECT folder, media_id, manual, source FROM catalog_matches
		WHERE `+where+` ORDER BY folder LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		dbErr(w)
		return
	}
	entries := []adminMatchEntry{}
	for rows.Next() {
		var e adminMatchEntry
		rows.Scan(&e.Folder, &e.MediaID, &e.Manual, &e.Source)
		entries = append(entries, e)
	}
	rows.Close()
	// titles resolve per page (bounded by the limit cap), not per table
	for i := range entries {
		entries[i].Title = s.cachedTitle(entries[i].Source, entries[i].MediaID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "entries": entries})
}

// handleAdminTTL sets the cache TTL overrides in hours (0 = default).
// PUT /api/admin/ttl {"anilistH":24,"tmdbH":24,"plexH":6}
func (s *Server) handleAdminTTL(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AnilistH int `json:"anilistH"`
		TmdbH    int `json:"tmdbH"`
		PlexH    int `json:"plexH"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	for _, v := range []int{in.AnilistH, in.TmdbH, in.PlexH} {
		if v < 0 || v > 720 {
			writeErr(w, http.StatusBadRequest, "hours must be 0..720 (0 = default)")
			return
		}
	}
	db.SetSetting(s.DB, "ttl_anilist_h", strconv.Itoa(in.AnilistH))
	db.SetSetting(s.DB, "ttl_tmdb_h", strconv.Itoa(in.TmdbH))
	db.SetSetting(s.DB, "ttl_plex_h", strconv.Itoa(in.PlexH))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAdminIndexConfig sets one server's crawler interval/budget
// (0 = default).
// PUT /api/admin/index/{id}/config {"intervalMin":5,"batch":20}
func (s *Server) handleAdminIndexConfig(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var in struct {
		IntervalMin int `json:"intervalMin"`
		Batch       int `json:"batch"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.IntervalMin < 0 || in.IntervalMin > crawlMaxInterval || in.Batch < 0 || in.Batch > crawlMaxBatch {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("intervalMin must be 0..%d, batch 0..%d (0 = default)", crawlMaxInterval, crawlMaxBatch))
		return
	}
	db.SetSetting(s.DB, fmt.Sprintf("crawl_interval_min:%d", id), strconv.Itoa(in.IntervalMin))
	db.SetSetting(s.DB, fmt.Sprintf("crawl_batch:%d", id), strconv.Itoa(in.Batch))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAdminMatchDelete removes one catalog match row, manual or not
// (explicit single-row admin action). The folder re-appears as pending on
// the next catalog poll and gets matched automatically again.
// DELETE /api/admin/matches?serverId=&folder=<full path>
func (s *Server) handleAdminMatchDelete(w http.ResponseWriter, r *http.Request) {
	serverID, _ := strconv.ParseInt(r.URL.Query().Get("serverId"), 10, 64)
	folder := r.URL.Query().Get("folder")
	if serverID == 0 || folder == "" {
		writeErr(w, http.StatusBadRequest, "serverId and folder required")
		return
	}
	res, err := s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ? AND folder = ?`, serverID, folder)
	if err != nil {
		dbErr(w)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}

// handleAdminIndexFlush drops the remote index of one server; the crawler
// rebuilds it from the root. Catalog matches are never touched.
// DELETE /api/admin/index/{id}
func (s *Server) handleAdminIndexFlush(w http.ResponseWriter, r *http.Request) {
	res, err := s.DB.Exec(`DELETE FROM remote_index WHERE server_id = ?`, pathID(r))
	if err != nil {
		dbErr(w)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"deleted": n})
}
