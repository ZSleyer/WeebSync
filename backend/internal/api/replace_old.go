package api

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nssteinbrenner/anitogo"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// An upgrade sync fetches a better copy of an episode into the folder the old
// one lives in. The rename template rarely produces the old file's exact name
// (release names, another container, a v2 tag), so the new file would sit next
// to the old one and the library would hold the episode twice. With ReplaceOld
// set, the old copy is moved into a trash folder beside it once the new file is
// in place, and the sweep deletes it after a grace period. Moving rather than
// deleting keeps a mis-parsed name from costing a file.
const (
	trashDir = ".weebsync-trash"
	// trashTTL is how long a displaced copy stays recoverable.
	// ponytail: fixed grace period, make it a setting if anyone asks
	trashTTL = 14 * 24 * time.Hour
)

// skipTrash keeps a directory walk out of the trash folder, so a copy waiting
// to be deleted is not counted as owned, duplicated, or complete.
func skipTrash(d fs.DirEntry) error {
	if d.IsDir() && d.Name() == trashDir {
		return fs.SkipDir
	}
	return nil
}

// DownloadFinished is wired as transfer.OnFinished: an upgrade sync moves the
// copy it improved on aside, then the owner is told as usual.
func (s *Server) DownloadFinished(d *transfer.Download) {
	if d.Status == "done" && d.ReplaceOld {
		s.replaceOldCopy(d)
	}
	s.NotifyDownloadFinished(d)
}

// replaceOldCopy moves the older copy of the episode a finished download
// carries into the trash folder of its directory: every other video there with
// the same episode number (season agreeing or absent), plus their sidecars. A
// file without an episode number is a movie: it replaces the one other video in
// its folder, and leaves a folder with several alone.
func (s *Server) replaceOldCopy(d *transfer.Download) {
	dir, err := s.safeLocal(filepath.Dir(d.LocalPath))
	if err != nil {
		return
	}
	newBase := filepath.Base(d.LocalPath)
	se, ep := episodeNumbers(newBase, path.Base(d.RemotePath))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var old []string
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || name == newBase || !videoExt[strings.ToLower(filepath.Ext(name))] {
			continue
		}
		if ep > 0 && !sameEpisode(name, se, ep) {
			continue
		}
		old = append(old, name)
	}
	if ep == 0 && len(old) != 1 {
		return
	}
	for _, name := range old {
		s.trashFile(dir, name, entries)
	}
}

// sameEpisode reports whether a file name carries exactly this episode: one
// number, equal to ep, in the same season or in none (files inside a season
// folder often carry no season token). A multi-episode file is never a match -
// it would vanish when its first episode arrives.
func sameEpisode(name string, se, ep int) bool {
	p := anitogo.Parse(name, anitogo.DefaultOptions)
	if len(p.EpisodeNumber) != 1 {
		return false
	}
	n, err := strconv.Atoi(p.EpisodeNumber[0])
	if err != nil || n != ep {
		return false
	}
	if len(p.AnimeSeason) > 0 {
		if s, _ := strconv.Atoi(p.AnimeSeason[0]); s != 0 && s != se {
			return false
		}
	}
	return true
}

// trashFile moves one video and its sidecars (same stem, non-video extension)
// into dir/.weebsync-trash and records them for the sweep.
func (s *Server) trashFile(dir, name string, entries []fs.DirEntry) {
	td := filepath.Join(dir, trashDir)
	if err := os.MkdirAll(td, 0o755); err != nil {
		slog.Warn("trash folder not created", "dir", logSafe(dir), "err", err)
		return
	}
	// Plex honours this; the walkers here skip the folder by name
	if _, err := os.Stat(filepath.Join(td, ".plexignore")); err != nil {
		os.WriteFile(filepath.Join(td, ".plexignore"), []byte("*\n"), 0o644)
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name)) + "."
	now := time.Now().Unix()
	for _, e := range entries {
		n := e.Name()
		if !e.Type().IsRegular() {
			continue
		}
		if n != name && (!strings.HasPrefix(n, stem) || videoExt[strings.ToLower(filepath.Ext(n))]) {
			continue
		}
		dst := filepath.Join(td, n)
		if err := os.Rename(filepath.Join(dir, n), dst); err != nil {
			slog.Warn("old copy not moved", "file", logSafe(n), "err", err)
			continue
		}
		s.DB.Exec(`INSERT OR REPLACE INTO trash_files (path, trashed_at) VALUES (?, ?)`, dst, now)
		slog.Info("old copy moved to trash", "file", logSafe(n), "dir", logSafe(dir))
	}
}

// emptyTrash deletes the displaced copies whose grace period is over, and the
// trash folder itself once nothing but the ignore marker is left. Only paths
// inside a trash folder under an allowed root are ever removed, whatever a row
// says.
func (s *Server) emptyTrash() {
	rows, err := s.DB.Query(`SELECT path FROM trash_files WHERE trashed_at < ?`, time.Now().Add(-trashTTL).Unix())
	if err != nil {
		return
	}
	var paths []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			paths = append(paths, p)
		}
	}
	rows.Close()
	for _, p := range paths {
		abs, err := s.safeLocal(p)
		if err != nil || abs != p || filepath.Base(filepath.Dir(p)) != trashDir {
			s.DB.Exec(`DELETE FROM trash_files WHERE path = ?`, p)
			continue
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("trash not deleted", "file", logSafe(p), "err", err)
			continue
		}
		s.DB.Exec(`DELETE FROM trash_files WHERE path = ?`, p)
		slog.Info("trash deleted", "file", logSafe(p))
		td := filepath.Dir(p)
		if left, err := os.ReadDir(td); err == nil && len(left) == 1 && left[0].Name() == ".plexignore" {
			os.Remove(filepath.Join(td, ".plexignore"))
			os.Remove(td)
		}
	}
}
