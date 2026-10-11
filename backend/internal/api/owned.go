package api

import (
	"log/slog"
	"path/filepath"
	"strconv"

	"github.com/ch4d1/weebsync/internal/db"
)

// watchOwned is the owned filter a watch check hands EnqueueSkipping: the
// episodes the library already holds under some other name, keyed by the
// SxxEyy the watch's rename gives a file. nil when nothing is known, which
// skips nothing - every source here fails open, because a wrong "you have it"
// silently stops a sync while a wrong "you don't" costs one download.
func (s *Server) watchOwned(w Watch) func(local string) bool {
	have := map[int]bool{}
	if truthySetting(db.Setting(s.DB, "plex_skip_owned")) {
		s.addPlexOwned(w, have)
	}
	if len(have) == 0 {
		return nil
	}
	return func(local string) bool {
		return have[targetEpKey(local)]
	}
}

// targetEpKey reads the SxxEyy off a local target name, 0 when it has none.
func targetEpKey(local string) int {
	m := epSeasonRe.FindStringSubmatch(filepath.Base(local))
	if m == nil {
		return 0
	}
	se, _ := strconv.Atoi(m[1])
	ep, _ := strconv.Atoi(m[2])
	if ep == 0 {
		return 0
	}
	return epKey(se, ep)
}

// addPlexOwned adds the episodes Plex holds of the show the watch feeds. Only
// a show found by identity counts (the series ids, or the folder Plex
// scanned): the title route is a guess, and skipping on a guess is not safe.
// A watch that renames in another order than Plex numbers in is left alone
// too - its S02E01 and Plex's S02E01 need not be the same episode.
func (s *Server) addPlexOwned(w Watch, have map[int]bool) {
	sh, ord, _, ok := s.plexShowForWatch(w, "") // "": no title route
	if !ok {
		return
	}
	if w.RenameOrdering != "" && ord.Order != "" && w.RenameOrdering != ord.Order {
		return
	}
	// ponytail: one allLeaves per check and watch; cache per show if a large
	// library makes the checks slow
	eps, err := s.plexClient().Episodes(sh.RatingKey)
	if err != nil {
		slog.Debug("plex owned episodes", "watch", w.ID, "err", err)
		return
	}
	for _, e := range eps {
		have[epKey(e.Season, e.Episode)] = true
	}
}
