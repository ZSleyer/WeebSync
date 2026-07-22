package api

import (
	"context"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

const (
	sweepTick      = 5 * time.Minute // scheduler granularity for the match sweep
	sweepInterval  = 30 * time.Minute
	sweepBatch     = 30             // max match enqueues per server per sweep, protects the provider rate limiters
	variantRecheck = 24 * time.Hour // recompute a folder's quality at most this often
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
			// enrich series bundles with Plex's authoritative tvdb/tmdb ids
			// (cross-provider bundling, grounded in Plex); no-op without Plex
			s.reconcilePlex(sweepBatch)
			// retry matches that BackfillSeries skipped because their metadata
			// wasn't cached yet - the self-healing net that makes the migration
			// of old matches onto the series structure eventually complete
			s.relinkOrphans(sweepBatch)
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
