package api

import (
	"context"
	"fmt"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

const (
	sweepTick      = 5 * time.Minute // scheduler granularity for the match sweep
	sweepInterval  = 30 * time.Minute
	sweepBatch     = 30             // max match enqueues per server per sweep, protects the provider rate limiters
	variantRecheck = 12 * time.Hour // recompute a folder's quality at most this often
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
			rows, err := s.DB.Query(`SELECT id FROM servers`)
			if err != nil {
				continue
			}
			var ids []int64
			for rows.Next() {
				var id int64
				rows.Scan(&id)
				ids = append(ids, id)
			}
			rows.Close()
			// server 0 (local filesystem) is swept too - it has scope marks
			// and catalog matches, just no remote_index for quality
			ids = append(ids, 0)
			now := time.Now()
			for _, id := range ids {
				if now.Sub(last[id]) < sweepInterval {
					continue
				}
				last[id] = now
				s.sweepServer(ctx, id, sweepBatch)
			}
			// refresh the external anime-lists mapping (AniList id -> shared
			// TVDB/TMDB/IMDB id + season), the bridge that lets local (Plex) and
			// remote copies line up per (show, season). Daily, dataset is large.
			if last := db.Setting(s.DB, "anime_ids_at"); last == "" || olderThan(last, 24*time.Hour) {
				s.runJob("anime:ids", func(context.Context) { s.refreshAnimeIDs() })
			}
			// enrich series bundles with Plex's authoritative tvdb/tmdb ids
			// (cross-provider bundling, grounded in Plex); no-op without Plex
			s.reconcilePlex(sweepBatch)
			// retry matches that BackfillSeries skipped because their metadata
			// wasn't cached yet - the self-healing net that makes the migration
			// of old matches onto the series structure eventually complete
			s.relinkOrphans(sweepBatch)
			// once an hour, index the Plex library's LOCAL quality (server-0
			// variants) so upgrade suggestions compare what you own against a
			// better remote source, not two remote copies. Plex-API heavy.
			if last := db.Setting(s.DB, "plex_indexed_at"); last == "" || olderThan(last, time.Hour) {
				s.runJob("plex:index", func(context.Context) { s.indexPlexLibrary() })
			}
			// select preferred Plex audio/sub streams on freshly indexed
			// episodes of watches with a playback preference (no-op when empty)
			s.processPlexStreamQueue()
			// pull every provider's title translations for new/stale series
			// (budgeted; new bundles have an empty stamp and are picked up first)
			s.refreshSeriesTitles(ctx, titlesBudget)
			// keep each user's aggregated suggestion blob warm so the page loads
			// instantly instead of assembling on the first request
			s.warmSuggestions()
		}
	}
}

// sweepServer enqueues matches for unmatched folders under this server's scope
// marks and refreshes stale variants, both capped by budget.
func (s *Server) sweepServer(ctx context.Context, serverID int64, budget int) {
	scopes, err := s.DB.Query(`SELECT path, kind FROM catalog_scopes WHERE server_id = ?`, serverID)
	if err != nil {
		return
	}
	type scope struct{ path, kind string }
	var marks []scope
	for scopes.Next() {
		var m scope
		scopes.Scan(&m.path, &m.kind)
		marks = append(marks, m)
	}
	scopes.Close()

	queued := 0
	for _, m := range marks {
		if queued >= budget {
			return
		}
		// direct child directories with no catalog match yet
		rows, err := s.DB.Query(`SELECT path, name FROM remote_index
			WHERE server_id = ? AND is_dir = 1 AND parent = ?
			  AND NOT EXISTS (SELECT 1 FROM catalog_matches cm
			                  WHERE cm.server_id = remote_index.server_id AND cm.folder = remote_index.path)
			LIMIT ?`, serverID, m.path, budget-queued)
		if err != nil {
			continue
		}
		type child struct{ path, name string }
		var kids []child
		for rows.Next() {
			var c child
			rows.Scan(&c.path, &c.name)
			kids = append(kids, c)
		}
		rows.Close()
		for _, c := range kids {
			s.queueScopedMatch(serverID, c.path, c.name, m.kind, false)
			queued++
		}
		if ctx.Err() != nil {
			return
		}
	}

	// refresh variants that are missing or older than variantRecheck for
	// already-matched folders (remote only; local has no remote_index)
	if serverID != 0 {
		s.refreshStaleVariants(serverID, budget)
	}
}

// refreshStaleVariants recomputes quality for matched folders whose variant is
// missing or stale, capped by budget.
func (s *Server) refreshStaleVariants(serverID int64, budget int) {
	cutoff := time.Now().UTC().Add(-variantRecheck).Format(time.RFC3339)
	rows, err := s.DB.Query(`SELECT cm.folder FROM catalog_matches cm
		LEFT JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id = ? AND cm.media_id != 0
		  AND (cv.folder IS NULL OR cv.computed_at < ?)
		LIMIT ?`, serverID, cutoff, budget)
	if err != nil {
		return
	}
	var folders []string
	for rows.Next() {
		var f string
		rows.Scan(&f)
		folders = append(folders, f)
	}
	rows.Close()
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
	rows.Close()
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
	var ids []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		key := fmt.Sprintf("suggestions:%d", id)
		var fetched string
		s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, key).Scan(&fetched)
		stale := true
		if t, perr := time.Parse(sqliteTime, fetched); perr == nil {
			stale = time.Since(t) > suggestTTL
		}
		if stale {
			uid := id
			s.runJob(key, func(ctx context.Context) { s.buildUserSuggestions(ctx, uid) })
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
	type row struct {
		serverID int64
		folder   string
		mediaID  int
		source   string
	}
	var all []row
	for rows.Next() {
		var r row
		rows.Scan(&r.serverID, &r.folder, &r.mediaID, &r.source)
		all = append(all, r)
	}
	rows.Close()
	for _, r := range all {
		s.linkSeries(r.source, r.mediaID)
		s.refreshVariant(r.serverID, r.folder)
	}
	db.SetSetting(s.DB, "series_backfilled", "1")
}

// suggestionFormat is bumped whenever the shape/content of the cached suggestion
// blob changes (e.g. localized titles), so a deploy drops stale blobs once
// instead of waiting out the 30-minute TTL.
const suggestionFormat = "titles-v7"

// ClearStaleSuggestionCache drops the cached per-user suggestion blobs once when
// the suggestion format version changed since the last boot. Cheap no-op after
// the first run of a given version.
func (s *Server) ClearStaleSuggestionCache() {
	if db.Setting(s.DB, "sugg_fmt") == suggestionFormat {
		return
	}
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`)
	// TVDB media cached before the English-translation fix hold native titles;
	// drop them so they re-fetch with a latinized title (background, rate-limited).
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'tvdb:media:%'`)
	// the Plex missing-sequel blob caches each sequel's media (with its old
	// native title); drop it so the sequels re-resolve with the fixed titles.
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key = 'plex:suggestions:v3'`)
	db.SetSetting(s.DB, "sugg_fmt", suggestionFormat)
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
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches cm
		JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id != 0 AND cm.media_id != 0 AND cv.show_key = ''`).Scan(&staleRemote)
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_variants WHERE server_id = 0 AND show_key = ''`).Scan(&staleLocal)
	if staleRemote == 0 && staleLocal == 0 {
		db.SetSetting(s.DB, "units_backfilled_v1", "1") // nothing to fix
		return
	}
	// folderUnit resolves anime seasons via the Fribb map - make sure it is loaded
	var animeN int
	s.DB.QueryRow(`SELECT COUNT(*) FROM anime_ids`).Scan(&animeN)
	if animeN == 0 {
		s.refreshAnimeIDs()
	}
	// re-derive the unit for every remote matched folder whose variant lacks it
	if rows, err := s.DB.Query(`SELECT cm.server_id, cm.folder FROM catalog_matches cm
		JOIN catalog_variants cv ON cv.server_id = cm.server_id AND cv.folder = cm.folder
		WHERE cm.server_id != 0 AND cm.media_id != 0 AND cv.show_key = ''`); err == nil {
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
		rows.Close()
		for _, x := range todo {
			s.refreshVariant(x.sid, x.folder)
		}
	}
	// stale server-0 rows are the OLD per-show Plex index (no show_key). Drop them
	// and force a per-season re-index on the next sweep tick.
	if staleLocal > 0 {
		s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = 0`)
		s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = 0`)
		db.SetSetting(s.DB, "plex_indexed_at", "")
	}
	// rebuild the cached suggestion blobs against the now-populated units
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`)
	db.SetSetting(s.DB, "units_backfilled_v1", "1")
}
