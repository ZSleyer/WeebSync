package api

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"path"
	"path/filepath"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/rename"
)

// unsortedDir is the folder a watch collects episodes in whose number the
// provider did not know yet. Named in the user's language, once, when it is
// created - a later language switch does not rename what is on disk, and it
// does not have to: every waiting file is remembered by its path.
func (s *Server) unsortedDir(userID int64) string {
	return tr(s.userLocale(userID), "folder.unsorted")
}

// pendingRemotePaths lists the remote files of one watch that are already
// waiting in the collecting folder. Enqueue only skips what is complete at the
// EXPECTED target, so without this the next check would see the season folder
// still missing the episode and fetch it a second time - gigabytes per round.
// A list that could not be read whole is an error, never a shorter list: the
// caller must not take what is missing from it for missing on disk.
func (s *Server) pendingRemotePaths(watchID int64) (map[string]bool, error) {
	out := map[string]bool{}
	rows, err := s.DB.Query(`SELECT remote_path FROM pending_episodes WHERE watch_id = ?`, watchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out[p] = true
	}
	return out, rows.Err()
}

// rememberPending records the freshly downloaded files that are waiting for the
// provider. The download ids come from Enqueue, which does not say which id
// belongs to which file, so they are matched back by their remote base name.
func (s *Server) rememberPending(watchID int64, ids []int64, files []pendingFile) {
	if len(ids) == 0 || len(files) == 0 {
		return
	}
	byBase := map[string]pendingFile{}
	for _, f := range files {
		byBase[path.Base(f.Name)] = f
	}
	for _, id := range ids {
		var remote, local string
		if s.DB.QueryRow(`SELECT remote_path, local_path FROM downloads WHERE id = ?`, id).
			Scan(&remote, &local) != nil {
			continue
		}
		f, ok := byBase[filepath.Base(local)]
		if !ok {
			continue
		}
		if _, err := s.DB.Exec(`INSERT OR IGNORE INTO pending_episodes (download_id, watch_id, token, local_path, remote_path)
			VALUES (?, ?, ?, ?, ?)`, id, watchID, f.Token, local, remote); err != nil {
			// untracked, the file would sit in the collecting folder for good
			slog.Warn("pending episode not recorded", "download", id, "err", err)
		}
	}
}

// pendingCount is how many episodes of a watch wait for the provider, for the
// overview.
func (s *Server) pendingCount(watchID int64) int {
	var n int
	_ = s.DB.QueryRow(`SELECT COUNT(*) FROM pending_episodes WHERE watch_id = ?`, watchID).Scan(&n) // a count for display
	return n
}

// pendingRecheck is how long a waiting episode is left alone between attempts.
// The resolver rebuilds its map on a miss and rate-limits that itself; asking
// on every five-minute sweep tick would only burn ticks.
const pendingRecheck = 30 * time.Minute

// processPendingEpisodes moves collected episodes into place once the provider
// knows their number. Runs on every sweep tick, does nothing most of the time.
//
// Nothing is ever given up on: an entry disappears when it was resolved, when
// its file is gone, or when the watch or download it belongs to was deleted -
// the last one through ON DELETE CASCADE.
func (s *Server) processPendingEpisodes(ctx context.Context) {
	type entry struct {
		downloadID, watchID int64
		token, localPath    string
	}
	var todo []entry
	// an entry is recorded when its download is queued, so a long queue still
	// holds episodes whose file is not there yet; those wait for their
	// download, or the entry would be dropped as "moved by hand" and the file
	// left in the collecting folder for good
	rows, err := s.DB.Query(`SELECT p.download_id, p.watch_id, p.token, p.local_path FROM pending_episodes p
		JOIN downloads d ON d.id = p.download_id
		WHERE p.created_at < datetime('now', ?) AND d.status NOT IN ('queued','running','paused')`,
		fmt.Sprintf("-%d seconds", int(pendingRecheck.Seconds())))
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var e entry
		if rows.Scan(&e.downloadID, &e.watchID, &e.token, &e.localPath) == nil {
			todo = append(todo, e)
		}
	}
	if rows.Err() != nil {
		return // the next tick reads the table again
	}

	for _, e := range todo {
		if ctx.Err() != nil {
			return
		}
		// the file may have been moved or deleted by hand in the meantime
		if !s.localExists(e.localPath) {
			// a row that stays is dropped again on the next tick
			_, _ = s.DB.Exec(`DELETE FROM pending_episodes WHERE download_id = ?`, e.downloadID)
			continue
		}
		var w Watch
		if s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator,
				title_override, pattern, replacement, subfolder, aired_mapping, rename_provider,
				rename_ordering, rename_title_lang, rename_series_id, plex_audio_lang, plex_sub_lang
				FROM watches WHERE id = ?`, e.watchID).
			Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator,
				&w.TitleOverride, &w.Pattern, &w.Replacement, &w.Subfolder, &w.AiredMapping, &w.RenameProvider,
				&w.RenameOrdering, &w.RenameTitleLang, &w.RenameSeriesID, &w.PlexAudioLang, &w.PlexSubLang) != nil {
			continue
		}
		season, ep, ok := s.airResolver().Resolve(ctx, s.watchSeries(w), e.token)
		if !ok {
			// still unknown: leave it, and push the next attempt out by one
			// interval so this does not run on every tick
			// a failed push-out only means the next tick tries again
			_, _ = s.DB.Exec(`UPDATE pending_episodes SET created_at = datetime('now') WHERE download_id = ?`, e.downloadID)
			continue
		}
		s.filePendingEpisode(e.downloadID, w, e.localPath, season, ep)
	}
}

// filePendingEpisode renames a collected episode to what the provider now says
// and moves it into the season folder. The watch's own rename options build the
// name, so a corrected file is indistinguishable from one that mapped right
// away.
func (s *Server) filePendingEpisode(downloadID int64, w Watch, from string, season, ep int) {
	base := filepath.Base(from)
	opts := rename.Options{
		Mode: w.Mode, Template: w.Template, Separator: w.Separator,
		TitleOverride: w.TitleOverride, Pattern: w.Pattern, Replacement: w.Replacement,
		SeasonOverride: &season, EpisodeOverride: &ep,
	}
	if opts.Mode == "" {
		opts.Mode = "template"
	}
	name, err := rename.New(base, opts)
	if err != nil || name == "" {
		return // keep waiting rather than move it somewhere half-named
	}
	// the target is relative to the watch's own root, the same base Enqueue
	// joins onto - the collecting folder sits inside it
	root := w.LocalPath
	if w.Subfolder {
		root = path.Join(w.LocalPath, path.Base(w.RemotePath))
	}
	src, err := s.openLocal(from)
	if err != nil {
		return
	}
	defer src.Close()
	dst, err := s.openLocal(path.Join(root, name))
	if err != nil {
		return
	}
	defer dst.Close()
	if src.Root.Name() != dst.Root.Name() {
		slog.Warn("pending episode crosses configured roots", "from", logSafe(from), "to", logSafe(dst.Abs))
		return
	}
	if dst.Abs == from {
		_, _ = s.DB.Exec(`DELETE FROM pending_episodes WHERE download_id = ?`, downloadID) // retried next tick
		return
	}
	if _, err := dst.Root.Stat(dst.Name); err == nil {
		// the episode arrived by another route; the collected copy is the
		// duplicate, so stop tracking it rather than overwrite a good file
		slog.Info("pending episode already present", "target", logSafe(dst.Abs))
		_, _ = s.DB.Exec(`DELETE FROM pending_episodes WHERE download_id = ?`, downloadID) // retried next tick
		return
	}
	if err := dst.Root.MkdirAll(filepath.Dir(dst.Name), 0o755); err != nil {
		slog.Warn("pending episode mkdir", "dir", logSafe(filepath.Dir(dst.Abs)), "err", err)
		return
	}
	if err := src.Root.Rename(src.Name, dst.Name); err != nil {
		// across a filesystem boundary this fails; the file stays put and the
		// entry survives, so nothing is lost - it just needs a hand
		slog.Warn("pending episode move", "from", logSafe(from), "to", logSafe(dst.Abs), "err", err)
		return
	}
	slog.Info("pending episode filed", "from", logSafe(from), "to", logSafe(dst.Abs), "season", season, "episode", ep)
	// keep the history pointing at the file that exists, and only then let
	// the entry go - together, or the history lost its file
	if err := db.Tx(s.DB, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE downloads SET local_path = ? WHERE id = ?`, dst.Abs, downloadID); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM pending_episodes WHERE download_id = ?`, downloadID)
		return err
	}); err != nil {
		slog.Warn("pending episode filed but not recorded", "to", logSafe(dst.Abs), "err", err)
	}
	// The collecting folder sits inside the watch target, so Plex had already
	// indexed this file under its old name and the stream pass had already run
	// on it - successfully, which is why its queue row is gone. The move makes
	// Plex re-analyse it as a different part and the selection is lost with it,
	// so ask for the preference again.
	if w.PlexAudioLang != "" || w.PlexSubLang != "" {
		if _, err := s.DB.Exec(`INSERT OR IGNORE INTO plex_stream_queue (download_id, watch_id) VALUES (?, ?)`, downloadID, w.ID); err != nil {
			slog.Warn("plex stream preference not queued after the move", "download", downloadID, "err", err)
		}
	}
	s.plexRescan(filepath.Dir(dst.Abs))
}
