package api

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Inventory of everything the database holds that is not user input: caches,
// derived structures and the handful of tables that record a human decision.
//
// Before this list existed the maintenance page knew about the AniList cache
// and nothing else, so a wrong series identity - folded once, written to
// series/series_provider - survived every reset the UI offered. One registry
// per rebuildable body of data makes each of them visible, individually
// deletable and, through TestDataStoresCoverEverything, impossible to forget
// when a migration adds another one.
//
// Deliberately NOT in here: anything a user typed or a transfer produced
// (servers, watches, downloads, settings, accounts, credentials). Those are
// not rebuildable, so they must never end up behind a "delete" button here.

// dataStore kinds. cache and derived go in a reset; decision needs an explicit
// opt-in because nobody can rebuild a human's choice.
const (
	kindCache    = "cache"
	kindDerived  = "derived"
	kindDecision = "decision"
)

// dataStore is one rebuildable body of data: which tables carry it, what it
// costs to lose it, and what puts it back.
type dataStore struct {
	name    string   // stable slug, the API's identity for this store
	tables  []string // the tables it consists of, in delete order
	kind    string   // cache | derived | decision
	rebuild string   // slug of the job/mechanism that refills it, "" = on demand
	needs   []string // stores that have to be filled before this one can be
	where   string   // optional row filter, applies to tables[0] only
	// cache stores only: the key prefixes inside anilist_cache this store owns.
	// Several, because one family can be written under more than one key shape
	// and because a bumped format leaves its predecessors behind (reviews ->
	// reviews2 -> reviews3), which a single exact prefix would strand forever.
	prefixes []string
	// catchAll marks the one cache store defined by exclusion: everything in
	// anilist_cache that no other store's prefix claims. Its filter is generated
	// from the registry, so a new key family lands here instead of nowhere.
	catchAll bool
	// cache stores only: the TTL the owning client applies on reads - the
	// default, made configurable by the given settings key ("" = fixed).
	setting string
	ttl     time.Duration
	// timeCol is the column carrying the row's age, "" when the store has none.
	// timeTable names the table it sits on; "" means tables[0].
	timeTable string
	timeCol   string
	// keptOnReset marks stores the bulk reset deliberately walks past.
	keptOnReset bool
	// stamp is the settings key recording when the job last refilled this store.
	// A delete has to clear it as well: the job reads the stamp to decide it is
	// not due yet, so an emptied store with a fresh stamp sits out the whole
	// interval - a full day for the anime-lists mapping, which is exactly what
	// a reset on 2026-07-26 left behind.
	stamp string
}

// cacheStore is the shorthand for the many anilist_cache rows below: they all
// live in one table and all age by the same column.
func cacheStore(name string, ttl time.Duration, setting string, prefixes ...string) dataStore {
	return dataStore{
		name: name, tables: []string{"anilist_cache"}, kind: kindCache,
		prefixes: prefixes, setting: setting, ttl: ttl, timeCol: "fetched_at",
	}
}

// dataStores is the registry. Order is display order: caches grouped by the
// provider they came from, then the derived stack roughly in the order it
// rebuilds itself, then the decisions.
//
// The TTLs mirror what the owning client applies on read, so the "stale" count
// on the maintenance page means something. Where a client has no override
// setting the TTL is fixed and the setting is "".
var dataStores = []dataStore{
	// AniList. "reviews" without a colon on purpose: the page size bump left
	// reviews:/reviews2: rows behind that reviews3: alone would never reach.
	cacheStore("cache:anilist-search", 24*time.Hour, "ttl_anilist_h", "search:"),
	cacheStore("cache:anilist-media", 24*time.Hour, "ttl_anilist_h", "media:"),
	cacheStore("cache:anilist-relations", 24*time.Hour, "ttl_anilist_h", "rel2:"),
	cacheStore("cache:anilist-recommendations", 24*time.Hour, "ttl_anilist_h", "rec1:"),
	cacheStore("cache:anilist-reviews", 24*time.Hour, "ttl_anilist_h", "reviews"),
	cacheStore("cache:anilist-trending", 24*time.Hour, "ttl_anilist_h", "trending:"),
	cacheStore("cache:anilist-userlist", time.Hour, "", "alist"),

	// TMDB. Titles and season episode counts are per-title detail like media,
	// fetched through the same client with the same TTL, so they share its row.
	// "tmdb:coll" covers both tmdb:coll-of:<movie> and tmdb:collection:<id>.
	cacheStore("cache:tmdb-search", 24*time.Hour, "ttl_tmdb_h", "tmdb:search:"),
	cacheStore("cache:tmdb-media", 24*time.Hour, "ttl_tmdb_h", "tmdb:media:", "tmdb:title:", "tmdb:season:"),
	cacheStore("cache:tmdb-collections", 24*time.Hour, "ttl_tmdb_h", "tmdb:coll"),
	cacheStore("cache:tmdb-reviews", 24*time.Hour, "ttl_tmdb_h", "tmdb:reviews"),
	cacheStore("cache:tmdb-trending", 24*time.Hour, "ttl_tmdb_h", "tmdb:trending:"),
	cacheStore("cache:tmdb-userlist", time.Hour, "", "tmdb:watchlist:"),

	// TVDB: series, localized titles and episode lists, all under one prefix.
	cacheStore("cache:tvdb", 24*time.Hour, "ttl_tvdb_h", "tvdb:"),

	cacheStore("cache:plex", 6*time.Hour, "ttl_plex_h", "plex:"),

	// Audio and subtitle languages read out of a remote file's header. By far
	// the most expensive row in this table to refill: every miss pulls megabytes
	// over SFTP and runs ffprobe, which is why it is kept for a month.
	cacheStore("cache:langprobe", 720*time.Hour, "", "langprobe:"),
	// The per-user suggestion page, pre-assembled by the sweep so the first
	// visit does not have to build it.
	{name: "cache:suggestions", tables: []string{"anilist_cache"}, kind: kindCache,
		prefixes: []string{"suggestions:"}, ttl: suggestTTL, timeCol: "fetched_at", rebuild: "sweep"},
	// The net. Defined by exclusion from every prefix above, so a key family
	// nobody thought of still shows up here and still goes in a reset, instead
	// of quietly surviving one. Deliberately last: it is what is left over.
	{name: "cache:other", tables: []string{"anilist_cache"}, kind: kindCache,
		catchAll: true, timeCol: "fetched_at"},

	// The crawler's directory snapshot. Kept by the bulk reset: it is only a
	// picture of what is on the servers, and throwing it away forces every
	// server into a full re-crawl before anything can be matched at all.
	{name: "remote-index", tables: []string{"remote_index"}, kind: kindDerived,
		rebuild: "index-crawl", timeCol: "listed_at", keptOnReset: true},
	// The external anime-lists mapping (AniList id -> TVDB/TMDB/IMDB id).
	{name: "anime-ids", tables: []string{"anime_ids"}, kind: kindDerived, rebuild: "anime-ids",
		stamp: "anime_ids_at"},
	// Aired-order season boundaries per watched folder, built on demand from
	// TVDB/Plex/TMDB the next time a file needs a season number.
	{name: "season-maps", tables: []string{"season_maps", "season_maps_meta"}, kind: kindDerived,
		timeTable: "season_maps_meta", timeCol: "updated_at"},
	// Automatic folder -> media matches. Manual rows live in catalog-decisions.
	{name: "catalog-matches", tables: []string{"catalog_matches"}, kind: kindDerived,
		rebuild: "rematch-all", where: "manual = 0", needs: []string{"remote-index"}},
	// The canonical series identity. Children first so the delete does not lean
	// on ON DELETE CASCADE, which needs foreign_keys=ON to fire at all.
	{name: "series", tables: []string{"series_titles", "series_seasons", "series_provider", "series"},
		kind: kindDerived, rebuild: "sweep", needs: []string{"catalog-matches", "anime-ids"}},
	// Per-folder quality (resolution, dub/sub languages) behind the upgrade
	// suggestions.
	{name: "catalog-variants", tables: []string{"catalog_variants"}, kind: kindDerived,
		rebuild: "sweep", needs: []string{"catalog-matches", "remote-index"}, timeCol: "computed_at",
		stamp: "plex_indexed_at"},
	// Which folders the Plex reconciliation has already looked at.
	{name: "plex-reconciled", tables: []string{"plex_reconciled"}, kind: kindDerived,
		rebuild: "plex-sweep", needs: []string{"series"}, timeCol: "checked_at"},
	// Downloaded episodes parked until the provider knows their number.
	{name: "pending-episodes", tables: []string{"pending_episodes"}, kind: kindDerived,
		rebuild: "watch-check", timeCol: "created_at"},

	// Human decisions. Nothing rebuilds these, so the reset only touches them
	// when explicitly asked to.
	{name: "catalog-decisions", tables: []string{"catalog_matches", "catalog_scopes"}, kind: kindDecision,
		where: "manual = 1", keptOnReset: true},
	{name: "suggestion-dismissals", tables: []string{"suggestion_dismissals"}, kind: kindDecision,
		timeCol: "dismissed_at", keptOnReset: true},
}

func dataStoreFor(name string) (dataStore, bool) {
	for _, st := range dataStores {
		if st.name == name {
			return st, true
		}
	}
	return dataStore{}, false
}

// cacheStoreFor resolves the short scope name ("plex") the key-level cache
// endpoints are addressed by to its registry entry ("cache:plex").
func cacheStoreFor(scope string) (dataStore, bool) {
	st, ok := dataStoreFor("cache:" + scope)
	if !ok || st.kind != kindCache {
		return dataStore{}, false
	}
	return st, true
}

// claimedCachePrefixes is every key prefix the registry hands to a named cache
// store. The catch-all is the complement of this set, so the two together
// always cover anilist_cache exactly once.
func claimedCachePrefixes() []string {
	var out []string
	for _, st := range dataStores {
		if st.kind == kindCache {
			out = append(out, st.prefixes...)
		}
	}
	return out
}

// filter is the row condition for the store's first table plus its arguments.
// Cache stores filter by key prefix, everything else by the literal where.
func (st dataStore) filter() (string, []any) {
	if st.catchAll {
		// generated, never hand-written: whatever prefix someone adds above,
		// the complement here narrows by exactly that much on the next build
		var parts []string
		var args []any
		for _, p := range claimedCachePrefixes() {
			parts = append(parts, `key NOT LIKE ? || '%'`)
			args = append(args, p)
		}
		if len(parts) == 0 {
			return "", nil
		}
		return strings.Join(parts, " AND "), args
	}
	if len(st.prefixes) > 0 {
		parts := make([]string, len(st.prefixes))
		args := make([]any, len(st.prefixes))
		for i, p := range st.prefixes {
			parts[i], args[i] = `key LIKE ? || '%'`, p
		}
		return "(" + strings.Join(parts, " OR ") + ")", args
	}
	return st.where, nil
}

// ownsKey reports whether one exact cache key belongs to this store. The
// key-level delete uses it so a scoped delete can never reach a foreign key,
// including through the catch-all, which owns precisely what nobody claimed.
func (st dataStore) ownsKey(key string) bool {
	if st.catchAll {
		for _, p := range claimedCachePrefixes() {
			if strings.HasPrefix(key, p) {
				return false
			}
		}
		return true
	}
	for _, p := range st.prefixes {
		if strings.HasPrefix(key, p) {
			return true
		}
	}
	return false
}

// timeSource names the table and column carrying the store's row age.
func (st dataStore) timeSource() (table, col string) {
	if st.timeCol == "" {
		return "", ""
	}
	if st.timeTable != "" {
		return st.timeTable, st.timeCol
	}
	return st.tables[0], st.timeCol
}

// execer is what deleteStore needs: *sql.DB, *sql.Tx and *sql.Conn all fit.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// deleteStore empties one store, table by table in the registry's order, and
// reports how many rows went. The order is explicit on purpose: series_provider
// hangs off series with ON DELETE CASCADE, but foreign keys are a per-connection
// pragma in SQLite, so leaning on the cascade would leave orphans wherever it is
// off. Table names come from the registry, never from a request, so
// interpolating them carries no injection risk.
func deleteStore(ctx context.Context, ex execer, st dataStore) (int64, error) {
	where, args := st.filter()
	var total int64
	for i, table := range st.tables {
		q := "DELETE FROM " + table
		var a []any
		if i == 0 && where != "" { // the filter belongs to the first table only
			q += " WHERE " + where
			a = args
		}
		res, err := ex.ExecContext(ctx, q, a...)
		if err != nil {
			return total, fmt.Errorf("delete %s: %w", table, err)
		}
		n, _ := res.RowsAffected()
		total += n
	}
	// the job that refills this store skips a run it believes is not due, so the
	// stamp goes with the rows. Not counted: it is bookkeeping, not content.
	if st.stamp != "" {
		if _, err := ex.ExecContext(ctx, "DELETE FROM settings WHERE key = ?", st.stamp); err != nil {
			return total, fmt.Errorf("clear %s: %w", st.stamp, err)
		}
	}
	return total, nil
}

// adminDataStore is one inventory row: what the store is, how much of it there
// is, and what puts it back. Slugs only - the frontend owns the prose, so the
// page can stay bilingual.
type adminDataStore struct {
	Name   string   `json:"name" example:"catalog-matches"`
	Kind   string   `json:"kind" example:"derived"`
	Tables []string `json:"tables"`
	Rows   int64    `json:"rows"`
	// Bytes is the stored payload size; cache stores only, 0 elsewhere (an
	// estimate for the other tables would be a guess dressed up as a number).
	Bytes int64 `json:"bytes"`
	// Oldest/Newest are SQLite UTC stamps, "" when the store has no time column.
	Oldest string `json:"oldest"`
	Newest string `json:"newest"`
	// TTLSec and Stale are cache stores only (0 elsewhere).
	TTLSec int   `json:"ttlSec"`
	Stale  int64 `json:"stale"`
	// Rebuild is the job/mechanism slug that refills the store, "" = on demand.
	Rebuild string `json:"rebuild" example:"rematch-all"`
	// Needs lists the stores that must be filled before this one can be.
	Needs []string `json:"needs"`
	// KeptOnReset marks the stores a default reset walks past.
	KeptOnReset bool `json:"keptOnReset"`
}

// adminDataResponse is the full inventory.
type adminDataResponse struct {
	Stores []adminDataStore `json:"stores"`
}

// handleAdminData reports every rebuildable data store with its current size.
// GET /api/admin/data
//
// @Summary      Inventory rebuildable data stores
// @Description  Reports every rebuildable body of data in the database (caches, derived structures, recorded decisions) with row counts, size, age span, what rebuilds it and what it depends on (admin only). Names are stable slugs; the UI supplies the prose.
// @Tags         Admin
// @Produce      json
// @Success      200  {object}  adminDataResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/data [get]
func (s *Server) handleAdminData(w http.ResponseWriter, r *http.Request) {
	out := adminDataResponse{Stores: make([]adminDataStore, 0, len(dataStores))}
	for _, st := range dataStores {
		out.Stores = append(out.Stores, s.storeStat(st))
	}
	writeJSON(w, http.StatusOK, out)
}

// storeStat counts one store. Every count is best-effort: a stat query that
// fails leaves a zero rather than blanking the whole inventory.
func (s *Server) storeStat(st dataStore) adminDataStore {
	out := adminDataStore{
		Name:        st.name,
		Kind:        st.kind,
		Tables:      st.tables,
		Rebuild:     st.rebuild,
		Needs:       st.needs,
		KeptOnReset: st.keptOnReset,
	}
	if out.Needs == nil {
		out.Needs = []string{}
	}
	where, args := st.filter()
	cond := ""
	if where != "" {
		cond = " WHERE " + where
	}
	for i, table := range st.tables {
		a := args
		c := cond
		if i > 0 { // the filter belongs to the first table only
			a, c = nil, ""
		}
		var n int64
		s.DB.QueryRow("SELECT COUNT(*) FROM "+table+c, a...).Scan(&n)
		out.Rows += n
	}
	if timeTable, timeCol := st.timeSource(); timeCol != "" {
		c := ""
		var a []any
		if timeTable == st.tables[0] {
			c, a = cond, args
		}
		// NULLIF: remote_index stamps only directories, so the empty strings of
		// the file rows would otherwise always win MIN()
		s.DB.QueryRow(fmt.Sprintf(
			`SELECT COALESCE(MIN(NULLIF(%s,'')),''), COALESCE(MAX(NULLIF(%s,'')),'') FROM %s%s`,
			timeCol, timeCol, timeTable, c), a...).Scan(&out.Oldest, &out.Newest)
	}
	if st.kind == kindCache {
		out.TTLSec = int(s.scopeTTL(st) / time.Second)
		// the catch-all has no owning client and so no TTL; counting its rows
		// "stale" against a made-up one would be a number pretending to mean
		// something. Size is real either way.
		age := "0"
		a := append([]any{}, args...)
		if out.TTLSec > 0 {
			age = `datetime(fetched_at) <= datetime('now', ?)`
			a = append([]any{fmt.Sprintf("-%d seconds", out.TTLSec)}, a...)
		}
		s.DB.QueryRow(`SELECT COALESCE(SUM(LENGTH(payload)),0), COALESCE(SUM(`+age+`),0)
			FROM anilist_cache`+cond, a...).Scan(&out.Bytes, &out.Stale)
	}
	return out
}

// handleAdminDataDelete empties exactly one data store.
// DELETE /api/admin/data/{name}
//
// @Summary      Delete a data store
// @Description  Empties one rebuildable data store: every table it consists of, in the registry's delete order, honouring its row filter (admin only). Decision stores can be deleted here too - this endpoint asks no questions, the confirmation belongs in the UI.
// @Tags         Admin
// @Produce      json
// @Param        name  path  string  true  "data store slug"
// @Success      200  {object}  deletedResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/data/{name} [delete]
func (s *Server) handleAdminDataDelete(w http.ResponseWriter, r *http.Request) {
	st, ok := dataStoreFor(r.PathValue("name"))
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown data store")
		return
	}
	n, err := deleteStore(r.Context(), s.DB, st)
	if err != nil {
		dbErrDetail(w, "delete "+st.name, err)
		return
	}
	writeJSON(w, http.StatusOK, deletedResponse{Deleted: n})
}

// dataResetRequest configures the bulk reset.
type dataResetRequest struct {
	// IncludeDecisions also drops the manual matches, the scope marks and the
	// dismissed suggestions. Off by default: nothing rebuilds those.
	IncludeDecisions bool `json:"includeDecisions"`
	// Requeue re-runs the automatic match on every server afterwards.
	// Absent means true - a reset that leaves the catalog empty is not useful.
	Requeue *bool `json:"requeue"`
}

// dataResetResponse reports what the reset removed, what it left standing and
// how much rebuilding it queued.
type dataResetResponse struct {
	// Deleted maps store slug to the number of rows removed.
	Deleted map[string]int64 `json:"deleted"`
	// Kept lists the store slugs the reset deliberately left alone.
	Kept []string `json:"kept"`
	// Queued is how many folders were handed back to the matcher.
	Queued int `json:"queued"`
}

// handleAdminDataReset drops the derived stack in one transaction and re-queues
// the matcher.
// POST /api/admin/data/reset {"includeDecisions":false,"requeue":true}
//
// @Summary      Reset derived data
// @Description  Empties every cache and derived data store in a single transaction and, unless requeue is false, re-runs the automatic match on every server afterwards (admin only). The remote index is kept: it is only a snapshot of the servers' directories, and dropping it would force a full re-crawl before anything could be matched at all - it stays individually deletable and is named under "kept". Recorded decisions (manual matches, scope marks, dismissed suggestions) survive unless includeDecisions is set. Takes no backup; back the database up first.
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Param        request  body      dataResetRequest  false  "reset options"
// @Success      200  {object}  dataResetResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/data/reset [post]
func (s *Server) handleAdminDataReset(w http.ResponseWriter, r *http.Request) {
	in := dataResetRequest{}
	if r.ContentLength > 0 && !readJSON(w, r, &in) {
		return
	}
	requeue := in.Requeue == nil || *in.Requeue

	out := dataResetResponse{Deleted: map[string]int64{}, Kept: []string{}}
	var wipe []dataStore
	for _, st := range dataStores {
		// keptOnReset covers both reasons to skip a store: the remote index is
		// a directory snapshot nobody needs to lose, and a decision is nobody's
		// to throw away without being asked.
		if st.keptOnReset && (st.kind != kindDecision || !in.IncludeDecisions) {
			out.Kept = append(out.Kept, st.name)
			continue
		}
		wipe = append(wipe, st)
	}

	// Take the requeue list first. rematchAll reads catalog_matches to decide
	// what to search again, so calling it after the wipe would find nothing and
	// leave the catalog to the sweep - which only picks up folders under a scope
	// mark, and only 30 per server per half hour.
	var requeueList []catalogMatch
	if requeue {
		// with includeDecisions the manual rows are being thrown away too, so
		// their folders need a fresh search as much as the automatic ones
		cond := "manual = 0"
		if in.IncludeDecisions {
			cond = "1 = 1"
		}
		requeueList = s.automaticMatches(cond)
	}

	// One transaction: a reset that dies halfway leaves exactly the half-state
	// it was meant to get rid of. BEGIN IMMEDIATE on a pinned connection - the
	// pool would otherwise scatter the statements across connections, and a
	// deferred transaction only takes its write lock on the first write.
	ctx := r.Context()
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		dbErrDetail(w, "reset conn", err)
		return
	}
	defer conn.Close()
	// Wait for the background jobs instead of failing at them. The pool's 5 s
	// (internal/db.Open) is sized for the request path; a sweep or an anime-ids
	// refresh holding the write lock for longer than that used to end this whole
	// operation with SQLITE_BUSY. Per connection, so it goes back to the pool's
	// value before anyone else gets this connection.
	conn.ExecContext(ctx, "PRAGMA busy_timeout = 30000")
	defer conn.ExecContext(context.WithoutCancel(ctx), "PRAGMA busy_timeout = 5000")
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		dbErrDetail(w, "reset begin", err)
		return
	}
	for _, st := range wipe {
		n, derr := deleteStore(ctx, conn, st)
		if derr != nil {
			conn.ExecContext(ctx, "ROLLBACK")
			dbErrDetail(w, "reset "+st.name, derr)
			return
		}
		out.Deleted[st.name] = n
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		conn.ExecContext(ctx, "ROLLBACK")
		dbErrDetail(w, "reset commit", err)
		return
	}

	// Queue only after the commit: the match worker writes back into
	// catalog_matches, and anything it wrote while the transaction was open
	// would have been deleted again.
	s.queueMatches(requeueList)
	out.Queued = len(requeueList)
	writeJSON(w, http.StatusOK, out)
}
