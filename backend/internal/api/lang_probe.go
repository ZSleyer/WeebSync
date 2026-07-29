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
	// langProbeTick is the background pace: slow, because measuring the whole
	// candidate set is worth a night, not a burst.
	langProbeTick = 10 * time.Minute
	// langProbeRush is the pace while a suggestion someone is LOOKING at is
	// waiting on a measurement. Those are a handful of folders at a time and the
	// answer is wanted now, not tonight.
	langProbeRush = 30 * time.Second
	// langProbeBudget is how many folders one pass may open. Each one pulls
	// probeHeaderBytes (12 MiB) over the connection the sync shares, at the
	// lowest priority the pool offers.
	//
	// ponytail: a flat per-pass count, not a bandwidth budget. It is the number
	// to raise once a night of sweeps shows what this actually costs; a real
	// rate limit is the upgrade path if a slow host ever notices.
	langProbeBudget = 5
	// wantedProbeMax bounds the priority set. It only ever holds what a build
	// actually held back, which is small; the cap is there so a pathological
	// catalogue cannot turn it into a second copy of the candidate list.
	wantedProbeMax = 200
)

// wantedProbe names one remote folder a card is waiting on.
type wantedProbe struct {
	serverID int64
	folder   string
}

// wantProbe marks a remote folder as one a suggestion is waiting on right now.
//
// buildUpgrades calls this when it holds a language gain back for want of a
// measurement. Whoever is reading that card is the one person who wants the
// answer, so the loop takes these first and at a much shorter pace instead of
// reaching them somewhere in a night's worth of background work.
//
// ponytail: in memory, not a table. A restart forgets the list and the next
// page view rebuilds it in the same moment it would have been needed.
func (s *Server) wantProbe(serverID int64, folder string) {
	s.probeWantMu.Lock()
	defer s.probeWantMu.Unlock()
	if s.probeWant == nil {
		s.probeWant = map[wantedProbe]bool{}
	}
	if len(s.probeWant) >= wantedProbeMax {
		return
	}
	s.probeWant[wantedProbe{serverID, folder}] = true
}

// takeWantedProbes empties the priority set and returns what was in it.
func (s *Server) takeWantedProbes() []wantedProbe {
	s.probeWantMu.Lock()
	defer s.probeWantMu.Unlock()
	out := make([]wantedProbe, 0, len(s.probeWant))
	for w := range s.probeWant {
		out = append(out, w)
	}
	clear(s.probeWant)
	return out
}

func (s *Server) wantedProbesPending() bool {
	s.probeWantMu.Lock()
	defer s.probeWantMu.Unlock()
	return len(s.probeWant) > 0
}

// LangProbeLoop measures the remote copies an upgrade suggestion is waiting on.
//
// It deliberately looks at a narrow set: a remote folder that has never been
// measured AND whose unit the library already owns a copy of. Those are the only
// folders a suggestion can be built from, so probing the rest of a catalogue
// would pull gigabytes to answer questions nobody asked. The result lands in the
// probe cache (30 days, files are immutable) and the next sweep folds it into
// the variant row through scanQuality.
//
// Two paces, because the two kinds of work are not equally urgent. A folder
// behind a card the user has open is measured within half a minute; the rest of
// the catalogue is worked through in the background and may take a night. The
// wake-up is on the short interval either way - it just does nothing on most of
// them when there is no priority work.
func (s *Server) LangProbeLoop(ctx context.Context) {
	tick := time.NewTicker(langProbeRush)
	defer tick.Stop()
	var lastBackground time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if s.wantedProbesPending() {
			s.probeRemoteCandidates(ctx, langProbeBudget)
			continue
		}
		if time.Since(lastBackground) >= langProbeTick {
			lastBackground = time.Now()
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
	var todo []cand
	// what a card is waiting on comes first, in the order it was asked for
	for _, w := range s.takeWantedProbes() {
		var userID int64
		if s.DB.QueryRow(`SELECT user_id FROM servers WHERE id = ?`, w.serverID).Scan(&userID) != nil {
			continue
		}
		todo = append(todo, cand{userID, w.serverID, w.folder})
	}
	// a remote variant with no measurement yet, whose unit the library also
	// holds - "probed = 0" is the never-looked state, 2 means we looked and the
	// container would not answer, and re-opening those every ten minutes is how
	// an unreadable mp4 turns into a permanent download.
	//
	// Ordered by folder, which does not move. Ordering by computed_at looks
	// natural - oldest first - but a measured folder has its stamp cleared to
	// hand it to the next sweep, so it sorts to the FRONT and the loop keeps
	// picking the same handful for as long as the sweep takes to catch up.
	//
	// More rows are read than may be probed, because a candidate that is already
	// in the probe cache costs nothing and must not eat the budget: it is only
	// waiting for its row to be rewritten. The budget counts real openings.
	rows, err := s.DB.Query(`SELECT v.server_id, v.folder, sv.user_id
		FROM catalog_variants v
		JOIN servers sv ON sv.id = v.server_id
		WHERE v.server_id != 0 AND v.probed = 0 AND v.show_key != ''
		  AND EXISTS (SELECT 1 FROM catalog_variants l
		              WHERE l.server_id = 0 AND l.show_key = v.show_key
		                AND l.season = v.season AND l.is_movie = v.is_movie)
		ORDER BY v.folder LIMIT ?`, budget*20)
	if err != nil {
		return
	}
	for rows.Next() {
		var c cand
		if rows.Scan(&c.serverID, &c.folder, &c.userID) == nil {
			todo = append(todo, c)
		}
	}
	rows.Close()

	opened := 0
	for _, c := range todo {
		if ctx.Err() != nil || opened >= budget {
			return
		}
		rep := s.representativeRemote(c.serverID, c.folder)
		if rep == "" {
			continue // the crawler has not listed a video there yet
		}
		if _, _, hit := s.cachedRemoteLang(c.serverID, rep); hit {
			// measured already; the row simply has not been rewritten yet. Keep
			// the stamp cleared so the next sweep takes it, and move on to a
			// folder that has never been opened.
			s.DB.Exec(`UPDATE catalog_variants SET computed_at = '' WHERE server_id = ? AND folder = ?`,
				c.serverID, c.folder)
			continue
		}
		opened++
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
