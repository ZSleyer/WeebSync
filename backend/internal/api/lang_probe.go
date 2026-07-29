package api

import (
	"context"
	"log/slog"
	"time"
)

// Measuring the languages of a REMOTE copy, so an upgrade suggestion rests on
// what a file carries instead of what its name advertises.
//
// This is a loop of its own rather than another step in the sweep: SweepLoop
// works purely off the crawler's remote_index snapshot and never dials a server,
// and that promise is what lets it run every five minutes without touching the
// hosts. Pulling a file header is the opposite kind of work, so it gets its own
// clock and its own budget.

const (
	langProbeTick = 10 * time.Minute
	// langProbeBudget is how many folders one tick may open. Each one pulls
	// probeHeaderBytes (12 MiB) over the connection the sync shares, at the
	// lowest priority the pool offers.
	//
	// ponytail: a flat per-tick count, not a bandwidth budget. It is the number
	// to raise once a night of sweeps shows what this actually costs; a real
	// rate limit is the upgrade path if a slow host ever notices.
	langProbeBudget = 5
)

// LangProbeLoop measures the remote copies an upgrade suggestion is waiting on.
//
// It deliberately looks at a narrow set: a remote folder that has never been
// measured AND whose unit the library already owns a copy of. Those are the only
// folders a suggestion can be built from, so probing the rest of a catalogue
// would pull gigabytes to answer questions nobody asked. The result lands in the
// probe cache (30 days, files are immutable) and the next sweep folds it into
// the variant row through scanQuality.
func (s *Server) LangProbeLoop(ctx context.Context) {
	tick := time.NewTicker(langProbeTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.probeRemoteCandidates(ctx, langProbeBudget)
		}
	}
}

// probeRemoteCandidates opens up to budget unmeasured remote folders that an
// upgrade comparison is waiting on.
func (s *Server) probeRemoteCandidates(ctx context.Context, budget int) {
	type cand struct {
		userID, serverID int64
		folder           string
	}
	// a remote variant with no measurement yet, whose unit the library also
	// holds - "probed = 0" is the never-looked state, 2 means we looked and the
	// container would not answer, and re-opening those every ten minutes is how
	// an unreadable mp4 turns into a permanent download
	rows, err := s.DB.Query(`SELECT v.server_id, v.folder, sv.user_id
		FROM catalog_variants v
		JOIN servers sv ON sv.id = v.server_id
		WHERE v.server_id != 0 AND v.probed = 0 AND v.show_key != ''
		  AND EXISTS (SELECT 1 FROM catalog_variants l
		              WHERE l.server_id = 0 AND l.show_key = v.show_key
		                AND l.season = v.season AND l.is_movie = v.is_movie)
		ORDER BY v.computed_at LIMIT ?`, budget)
	if err != nil {
		return
	}
	var todo []cand
	for rows.Next() {
		var c cand
		if rows.Scan(&c.serverID, &c.folder, &c.userID) == nil {
			todo = append(todo, c)
		}
	}
	rows.Close()

	for _, c := range todo {
		if ctx.Err() != nil {
			return
		}
		rep := s.representativeRemote(c.serverID, c.folder)
		if rep == "" {
			continue // the crawler has not listed a video there yet
		}
		_, _, ok := s.probeRemoteLang(c.userID, c.serverID, rep)
		if !ok {
			// The container would not answer: an mp4 with its moov atom at the
			// end, a host that is down, no ffprobe. Record the attempt so the
			// comparison stops waiting for a measurement and falls back to the
			// name - marked as unconfirmed, which is what it is.
			//
			// Only the state is written, through a plain UPDATE rather than
			// storeVariant: this knows nothing about the row's unit, and
			// INSERT OR REPLACE would reset every column it cannot name.
			s.DB.Exec(`UPDATE catalog_variants SET probed = ? WHERE server_id = ? AND folder = ?`,
				int(probeFailed), c.serverID, c.folder)
			slog.Debug("remote language probe failed", "server", c.serverID, "folder", logSafe(c.folder),
				"reason", "the container would not answer - unreadable header, or the host is not reachable")
			continue
		}
		// The measurement is in the probe cache now, but scanQuality only reads
		// it when the row is recomputed - and that is gated on computed_at being
		// older than variantRecheck. Left alone, a folder measured minutes after
		// its last refresh would keep its guessed languages for another twelve
		// hours, which is the whole waiting time the gate was meant to end.
		// An empty stamp sorts before any cutoff, so refreshStaleVariants takes
		// it on the next sweep.
		s.DB.Exec(`UPDATE catalog_variants SET computed_at = '' WHERE server_id = ? AND folder = ?`,
			c.serverID, c.folder)
		slog.Info("remote languages measured", "server", c.serverID, "folder", logSafe(c.folder))
	}
}
