package api

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

const (
	sweepTick      = 5 * time.Minute // scheduler granularity for the match sweep
	sweepInterval  = 30 * time.Minute
	sweepBatch     = 30             // max match enqueues per server per sweep, protects the provider rate limiters
	variantRecheck = 12 * time.Hour // recompute a folder's quality at most this often
	// folders the Plex reconcile checks per sweep: it reads the cached Plex
	// index and asks no provider, so a whole library fits into one pass
	plexReconcileBatch = 5000
)

// SweepLoop is the background match cronjob: it scans scoped directories for
// folders that have no catalog match yet and queues them, and refreshes stale
// quality variants - all off the remote_index snapshot the crawler maintains,
// so it never dials a server itself. This is what turns "matched only when a
// user browses the folder" into "matched automatically once the crawler has
// seen it".
func (s *Server) SweepLoop(ctx context.Context) {
	tick := time.NewTicker(sweepTick)
	defer tick.Stop()
	last := map[int64]time.Time{} // per-server, this goroutine only
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.expireAuthRows()
			ids, err := s.serverIDs()
			if err != nil {
				slog.Warn("sweep: reading servers failed", "err", err)
				continue
			}
			// server 0 (local filesystem) is swept too - it has scope marks
			// and catalog matches, just no remote_index for quality
			ids = append(ids, 0)
			now := time.Now()
			for _, id := range ids {
				if now.Sub(last[id]) < sweepInterval {
					slog.Debug("sweep skip server", "server", id, "reason", "not due",
						"nextIn", (sweepInterval - now.Sub(last[id])).Round(time.Second))
					continue
				}
				last[id] = now
				// folders the structure speaks for are marked on their own;
				// their titles are matched by the job and by the sweep below
				if id != localServerID {
					s.detectMarksJob(id)
				}
				s.sweepServer(ctx, id, sweepBatch)
			}
			// refresh the external anime-lists mapping (AniList id -> shared
			// TVDB/TMDB/IMDB id + season), the bridge that lets local (Plex) and
			// remote copies line up per (show, season). Daily, dataset is large.
			if last := db.Setting(s.DB, "anime_ids_at"); last == "" || olderThan(last, 24*time.Hour) {
				slog.Info("sweep triggers job", "job", "anime:ids", "reason", "daily refresh due")
				s.runJob("anime:ids", func(context.Context) { s.refreshAnimeIDs() })
			}
			// throw out the cache rows nothing reads again (one-shot lookups,
			// aged detail blobs); the TTL only hides them, it never frees them
			if last := db.Setting(s.DB, "cache_pruned_at"); last == "" || olderThan(last, 24*time.Hour) {
				if n := s.pruneCache(); n > 0 {
					slog.Info("sweep pruned cache", "rows", n)
				}
				// only throttles the prune: a missed stamp prunes again next tick
				_ = db.SetSetting(s.DB, "cache_pruned_at", time.Now().UTC().Format(time.RFC3339))
			}
			// keep the planner's statistics in step with the tables as the
			// crawler and the prune grow and shrink them; a no-op while fresh
			db.Optimize(s.DB)
			// write down what the caches currently say is airing, before the
			// providers drop the slots that have passed - the calendar's only
			// source for the days just gone
			s.recordAirings()
			// enrich series bundles with Plex's authoritative tvdb/tmdb ids
			// (cross-provider bundling, grounded in Plex); no-op without Plex
			s.reconcilePlex(plexReconcileBatch)
			// retry matches that BackfillSeries skipped because their metadata
			// wasn't cached yet - the self-healing net that makes the migration
			// of old matches onto the series structure eventually complete
			s.relinkOrphans(sweepBatch)
			// once an hour, index the Plex library's LOCAL quality (server-0
			// variants) so upgrade suggestions compare what you own against a
			// better remote source, not two remote copies. Plex-API heavy.
			if last := db.Setting(s.DB, "plex_indexed_at"); last == "" || olderThan(last, time.Hour) {
				slog.Info("sweep triggers job", "job", "plex:index", "reason", "hourly local-quality index due")
				// an hour, not the usual five minutes: the first pass after an
				// empty probe cache measures the whole library, and cutting it
				// short would leave it measuring the same rest every time
				s.runJobFor("plex:index", time.Hour, s.indexPlexLibrary)
			}
			// once an hour, write down which dub episodes Crunchyroll has
			// released for the watches that filter for a dub; the calendar
			// projects the rest from them. No-op without such a watch.
			if last := db.Setting(s.DB, "dub_recorded_at"); last == "" || olderThan(last, time.Hour) {
				// only throttles the job: a missed stamp runs it again next tick
				_ = db.SetSetting(s.DB, "dub_recorded_at", time.Now().UTC().Format(time.RFC3339))
				s.runJobFor("dub:record", 10*time.Minute, s.recordDubAirings)
			}
			// select preferred Plex audio/sub streams on freshly indexed
			// episodes of watches with a playback preference (no-op when empty)
			s.backfillPlexStreams()
			s.processPlexStreamQueue()
			// file the episodes that were collected because the provider did
			// not know their number yet, once it does
			s.processPendingEpisodes(ctx)
			// delete what upgrade syncs moved aside once its grace period is over
			s.emptyTrash()
			// pull every provider's title translations for new/stale series
			// (budgeted; new bundles have an empty stamp and are picked up first)
			s.refreshSeriesTitles(ctx, titlesBudget)
			// decide what the newly bundled series are, so categorize reads
			// instead of guessing from provider badges
			s.refreshSeriesKinds(200)
			// fold the cours of a show into one entry, keeping their names as
			// season titles - the pass over what was bundled by title alone,
			// before the show level existed
			s.mergeShowSeries(200)
			// keep each user's aggregated suggestion blob warm so the page loads
			// instantly instead of assembling on the first request
			s.warmSuggestions()
			// and the global trending list the TV launcher reads
			s.warmTVTrending()
		}
	}
}

// serverIDs lists every configured server's id.
func (s *Server) serverIDs() ([]int64, error) {
	rows, err := s.DB.Query(`SELECT id FROM servers`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// sweepServer enqueues matches for unmatched folders under this server's scope
// marks and refreshes stale variants, both capped by budget.
func (s *Server) sweepServer(ctx context.Context, serverID int64, budget int) {
	scopes, err := s.DB.Query(`SELECT path, kind FROM catalog_scopes WHERE server_id = ? AND kind != ?`, serverID, scopeNone)
	if err != nil {
		return
	}
	defer scopes.Close()
	type scope struct{ path, kind string }
	var marks []scope
	for scopes.Next() {
		var m scope
		if scopes.Scan(&m.path, &m.kind) == nil {
			marks = append(marks, m)
		}
	}
	if err := scopes.Err(); err != nil {
		slog.Warn("sweep: reading scope marks failed", "server", serverID, "err", err)
		return
	}
	// folders a scope rule covers are marks too, though nothing stores them
	for _, m := range s.ruleMarks(serverID) {
		marks = append(marks, scope{m[0], m[1]})
	}

	if s.matchingOff() {
		marks = nil // every provider is switched off for matching: nothing is asked
	}
	queued := 0
	for _, m := range marks {
		if queued >= budget {
			slog.Debug("sweep budget exhausted", "server", serverID, "budget", budget)
			return
		}
		// direct child directories with no catalog match yet
		kids, err := s.unmatchedChildren(serverID, m.path, budget-queued)
		if err != nil {
			slog.Warn("sweep: listing unmatched folders failed", "server", serverID, "err", err)
			continue
		}
		for _, c := range kids {
			if isHelperDir(c.name) {
				continue
			}
			s.queueScopedMatch(serverID, c.path, c.name, m.kind, false)
			queued++
		}
		if ctx.Err() != nil {
			return
		}
	}

	if queued > 0 {
		slog.Info("sweep queued matches", "server", serverID, "queued", queued, "budget", budget)
	}

	// refresh variants that are missing or older than variantRecheck for
	// already-matched folders (remote only; local has no remote_index)
	if serverID != 0 {
		s.refreshStaleVariants(serverID, budget)
	}
}

type sweepChild struct{ path, name string }

// unmatchedChildren returns up to limit direct child directories of parent that
// have no catalog match yet.
func (s *Server) unmatchedChildren(serverID int64, parent string, limit int) ([]sweepChild, error) {
	rows, err := s.DB.Query(`SELECT path, name FROM remote_index
		WHERE server_id = ? AND is_dir = 1 AND parent = ?
		  AND NOT EXISTS (SELECT 1 FROM catalog_matches cm
		                  WHERE cm.server_id = remote_index.server_id AND cm.folder = remote_index.path)
		LIMIT ?`, serverID, parent, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var kids []sweepChild
	for rows.Next() {
		var c sweepChild
		if err := rows.Scan(&c.path, &c.name); err != nil {
			return nil, err
		}
		kids = append(kids, c)
	}
	return kids, rows.Err()
}

// refreshStaleVariants recomputes quality for matched folders whose variant is
// missing or stale, capped by budget.
func (s *Server) refreshStaleVariants(serverID int64, budget int) {
	cutoff := time.Now().UTC().Add(-variantRecheck).Format(time.RFC3339)
	// Oldest first, and a folder with no variant at all (NULL sorts first in
	// SQLite) before any of them. Without an order this was rowid order, i.e.
	// arbitrary: on a real catalogue thousands of folders are past the recheck
	// window at any moment, so a specific one waited days for its turn. That
	// matters because a stamp is now cleared deliberately - it is how a
	// just-measured folder asks to be rewritten next - and an arbitrary pick
	// ignored the request entirely.
	rows, err := s.DB.Query(`SELECT cm.folder FROM catalog_matches cm
		LEFT JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id = ? AND cm.media_id != 0
		  AND (cv.folder IS NULL OR cv.computed_at < ?)
		ORDER BY cv.computed_at
		LIMIT ?`, serverID, cutoff, budget)
	if err != nil {
		return
	}
	defer rows.Close()
	var folders []string
	for rows.Next() {
		var f string
		if rows.Scan(&f) == nil {
			folders = append(folders, f)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("sweep: reading stale variants failed", "server", serverID, "err", err)
		return
	}
	for _, f := range folders {
		s.refreshVariant(serverID, f)
	}
}

// relinkOrphans links catalog matches that have no series_provider row yet -
// the ones BackfillSeries skipped because sourceMedia had no cached metadata at
// boot. linkSeries queues the missing media fetch when it still can't resolve,
// so the row links on a later tick once the cache warms. Budget-bounded, runs
// every sweep, converges to zero. This is what makes the old-match migration
// reliable without a flag.
func (s *Server) relinkOrphans(budget int) {
	rows, err := s.DB.Query(`SELECT source, media_id FROM catalog_matches cm
		WHERE cm.media_id != 0
		  AND NOT EXISTS (SELECT 1 FROM series_provider sp
		                  WHERE sp.source = cm.source AND sp.media_id = cm.media_id)
		LIMIT ?`, budget)
	if err != nil {
		return
	}
	defer rows.Close()
	type orphan struct {
		source  string
		mediaID int
	}
	var orphans []orphan
	for rows.Next() {
		var o orphan
		if rows.Scan(&o.source, &o.mediaID) == nil {
			orphans = append(orphans, o)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("sweep: reading orphan matches failed", "err", err)
		return
	}
	for _, o := range orphans {
		s.linkSeries(o.source, o.mediaID)
	}
}

// olderThan reports whether an RFC3339 timestamp is more than d in the past
// (true also when it cannot be parsed, so a bad value forces a refresh).
func olderThan(ts string, d time.Duration) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err != nil || time.Since(t) > d
}

// warmSuggestions rebuilds each user's stale suggestion blob in the background,
// deduplicated by the same runJob key the endpoint uses, so a user's first
// visit finds the page pre-aggregated. Cheap: few users, no-op when fresh.
func (s *Server) warmSuggestions() {
	rows, err := s.DB.Query(`SELECT id FROM users`)
	if err != nil {
		return
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("sweep: reading users failed", "err", err)
		return
	}
	for _, id := range ids {
		key := fmt.Sprintf("suggestions:%d", id)
		var fetched string
		// no row or a failed read leaves "" and the blob counts as stale
		_ = s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, key).Scan(&fetched)
		stale := true
		if t, perr := time.Parse(sqliteTime, fetched); perr == nil {
			stale = time.Since(t) > suggestTTL
		}
		if stale {
			s.rebuildSuggestions(id)
		}
	}
}

// BackfillSeries links every existing catalog match into the series tables once,
// so the bundle layer covers matches made before it existed. Idempotent and
// gated by a settings flag; linkSeries skips already-linked providers, so a
// re-run is cheap but the flag avoids scanning the whole catalog every boot.
func (s *Server) BackfillSeries() {
	if db.Setting(s.DB, "series_backfilled") == "1" {
		return
	}
	rows, err := s.DB.Query(`SELECT server_id, folder, media_id, source FROM catalog_matches WHERE media_id != 0`)
	if err != nil {
		return
	}
	defer rows.Close()
	type row struct {
		serverID int64
		folder   string
		mediaID  int
		source   string
	}
	var all []row
	for rows.Next() {
		var r row
		if rows.Scan(&r.serverID, &r.folder, &r.mediaID, &r.source) == nil {
			all = append(all, r)
		}
	}
	if rows.Err() != nil {
		return // the flag below would leave the unread matches unlinked for good
	}
	for _, r := range all {
		if s.stopping() {
			return
		}
		s.linkSeries(r.source, r.mediaID)
		s.refreshVariant(r.serverID, r.folder)
	}
	s.setDoneFlag("series_backfilled")
}

// suggestionFormat is bumped whenever the shape/content of the cached suggestion
// blob changes (e.g. localized titles), so a deploy drops stale blobs once
// instead of waiting out the 30-minute TTL.
// v11: blobs carry only the user's own servers, and upgrade plans always send replace.
// v12: blobs carry the TMDB watchlist and trending errors of their build.
const suggestionFormat = "libscope-v12"

// ClearStaleSuggestionCache drops the cached per-user suggestion blobs once when
// the suggestion format version changed since the last boot. Cheap no-op after
// the first run of a given version.
func (s *Server) ClearStaleSuggestionCache() {
	if db.Setting(s.DB, "sugg_fmt") == suggestionFormat {
		return
	}
	// a delete that failed leaves the format unstamped, so the next boot
	// clears again instead of serving the stale blobs for good
	for _, q := range []string{
		`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`,
		// TVDB media cached before the English-translation fix hold native titles;
		// drop them so they re-fetch with a latinized title (background, rate-limited).
		`DELETE FROM anilist_cache WHERE key LIKE 'tvdb:media:%'`,
		// the Plex missing-sequel blob caches each sequel's media (with its old
		// native title); drop it so the sequels re-resolve with the fixed titles.
		`DELETE FROM anilist_cache WHERE key = 'plex:suggestions:v3'`,
	} {
		if _, err := s.DB.Exec(q); err != nil {
			slog.Warn("suggestion cache not cleared", "err", err)
			return
		}
	}
	if err := db.SetSetting(s.DB, "sugg_fmt", suggestionFormat); err != nil {
		slog.Warn("suggestion format not stamped", "err", err)
	}
}

// setDoneFlag marks a one-shot pass as done. A stamp that did not land only
// means the pass runs again next time, so it is logged, not fatal.
func (s *Server) setDoneFlag(key string) {
	if err := db.SetSetting(s.DB, key, "1"); err != nil {
		slog.Warn("done flag not stored", "key", key, "err", err)
	}
}

// backfillPlexStreams applies the Plex playback preference once to the episodes
// that predate the verdict column, so what a watch is missing is known for the
// whole library instead of only for what has been downloaded since.
//
// Until now the preference reached exactly the downloads queued after it was
// set: every episode that was already there when the preference was saved was
// never touched, and nothing recorded that. One pass per watch, once per
// install, then the flag makes it a single settings read forever after.
func (s *Server) backfillPlexStreams() {
	if db.Setting(s.DB, "plex_streams_backfilled") == "1" {
		return
	}
	if c := s.plexClient(); c == nil || c.Kind() != "plex" {
		return // no Plex yet: try again next tick, the flag stays unset
	}
	rows, err := s.DB.Query(`SELECT id FROM watches WHERE plex_audio_lang != '' OR plex_sub_lang != ''`)
	if err != nil {
		return
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	if rows.Err() != nil {
		return // the flag stays unset, the next tick reads the watches again
	}
	// through loadWatch, so the pass knows how this watch names its files - it
	// has to resolve a remote name to an episode number to know what it covers
	var todo []Watch
	for _, id := range ids {
		if wt, ok := s.loadWatch(id); ok {
			todo = append(todo, wt)
		}
	}
	for _, wt := range todo {
		s.applyPlexStreamsJob(wt)
	}
	s.setDoneFlag("plex_streams_backfilled")
	if len(todo) > 0 {
		slog.Info("plex stream preference backfill queued", "watches", len(todo))
	}
}

// BackfillUnits re-derives the canonical unit (show_key/season/is_movie) on
// catalog variants that predate the per-season model, and drops the stale
// server-0 Plex rows so indexPlexLibrary rebuilds them per season. Gated by a
// flag AND self-detecting: it only does work when old rows without a show_key
// actually exist, so a fresh install or an already-migrated instance is a no-op
// (force only when needed). Runs once at startup.
func (s *Server) BackfillUnits() {
	if db.Setting(s.DB, "units_backfilled_v1") == "1" {
		return
	}
	var staleRemote, staleLocal int
	// a count that failed to read is not "nothing to fix": that would stamp
	// the flag and skip the pass for good
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches cm
		JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id != 0 AND cm.media_id != 0 AND cv.show_key = ''`).Scan(&staleRemote); err != nil {
		slog.Warn("units backfill: counting remote rows failed", "err", err)
		return
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_variants WHERE server_id = 0 AND show_key = ''`).Scan(&staleLocal); err != nil {
		slog.Warn("units backfill: counting local rows failed", "err", err)
		return
	}
	if staleRemote == 0 && staleLocal == 0 {
		s.setDoneFlag("units_backfilled_v1") // nothing to fix
		return
	}
	// folderUnit resolves anime seasons via the Fribb map - make sure it is loaded
	var animeN int
	_ = s.DB.QueryRow(`SELECT COUNT(*) FROM anime_ids`).Scan(&animeN) // 0 on a failed read just refreshes the map
	if animeN == 0 {
		s.refreshAnimeIDs()
	}
	// re-derive the unit for every remote matched folder whose variant lacks
	// it. A read that failed ends the pass with the flag unset: set, it would
	// leave the unread folders without a unit for good.
	rows, err := s.DB.Query(`SELECT cm.server_id, cm.folder FROM catalog_matches cm
		JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id != 0 AND cm.media_id != 0 AND cv.show_key = ''`)
	if err != nil {
		return
	}
	defer rows.Close()
	type f struct {
		sid    int64
		folder string
	}
	var todo []f
	for rows.Next() {
		var x f
		if rows.Scan(&x.sid, &x.folder) == nil {
			todo = append(todo, x)
		}
	}
	if rows.Err() != nil {
		return
	}
	for _, x := range todo {
		if s.stopping() {
			return
		}
		s.refreshVariant(x.sid, x.folder)
	}
	// stale server-0 rows are the OLD per-show Plex index (no show_key). Drop them
	// and force a per-season re-index on the next sweep tick.
	if staleLocal > 0 {
		// stale rows that stay would keep the old per-show index alive, so a
		// failed write ends the pass with the flag unset
		for _, q := range []string{
			`DELETE FROM catalog_variants WHERE server_id = 0`,
			`DELETE FROM catalog_matches WHERE server_id = 0`,
		} {
			if _, err := s.DB.Exec(q); err != nil {
				slog.Warn("units backfill: dropping stale Plex rows failed", "err", err)
				return
			}
		}
		if err := db.SetSetting(s.DB, "plex_indexed_at", ""); err != nil {
			slog.Warn("units backfill: forcing the Plex re-index failed", "err", err)
			return
		}
	}
	// rebuild the cached suggestion blobs against the now-populated units
	if _, err := s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`); err != nil {
		slog.Warn("units backfill: dropping suggestion blobs failed", "err", err)
		return
	}
	s.setDoneFlag("units_backfilled_v1")
}

// expireAuthRows drops sessions and pending logins past their TTL. Sessions
// were only deleted when their cookie showed up again, so idle rows piled up
// forever. Both tables store UTC RFC3339, so a string compare is exact.
func (s *Server) expireAuthRows() {
	now := time.Now().UTC().Format(time.RFC3339)
	// housekeeping: a delete that fails leaves the rows for the next tick
	_, _ = s.DB.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, now)
	long, short := auth.IdleCutoffs(time.Now())
	_, _ = s.DB.Exec(`DELETE FROM sessions WHERE last_seen != '' AND ((remember = 1 AND last_seen <= ?) OR (remember = 0 AND last_seen <= ?))`, long, short)
	_, _ = s.DB.Exec(`DELETE FROM login_pending WHERE expires_at <= ?`, now)
}
