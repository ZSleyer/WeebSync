package api

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"strings"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// errMoveAcrossRoots: the old and the new folder lie under different media
// roots, which are different disks as a rule; a rename cannot cross them.
var errMoveAcrossRoots = errors.New("the new folder is on another media root, files cannot be moved there")

// moveResult is what moving a watch's files to its new folder did.
type moveResult struct {
	// Moved counts the entries now in the new folder
	Moved int `json:"moved"`
	// Kept names the entries left behind because the new folder already has
	// one of the same name: a move never overwrites
	Kept []string `json:"kept,omitempty"`
}

// moveBack renames the moved entries back into the old folder and removes
// the new folder again when the move created it and it is empty. It returns
// the entries that could not go back.
func moveBack(src, dst *transfer.LocalPath, done []string, created bool) (stuck []string) {
	for _, n := range done {
		if err := src.Root.Rename(filepath.Join(dst.Name, n), filepath.Join(src.Name, n)); err != nil {
			stuck = append(stuck, n)
		}
	}
	if created && len(stuck) == 0 {
		_ = src.Root.Remove(dst.Name) // best effort: only an empty folder goes
	}
	return stuck
}

// sharedWatchFolder names another watch whose files land in the same folder
// as this one's, "" when none does. Its files cannot be told apart from this
// watch's, so moving the folder's contents would take them along. Watches of
// every user count: the library is shared.
func (s *Server) sharedWatchFolder(id int64, folder string) (string, error) {
	same := func(p string) string {
		if abs, err := s.safeLocal(p); err == nil {
			return filepath.Clean(abs)
		}
		return filepath.Clean(p)
	}
	want := same(folder)
	rows, err := s.DB.Query(`SELECT remote_path, local_path, subfolder FROM watches WHERE id <> ?`, id)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var remote, local string
		var sub bool
		if err := rows.Scan(&remote, &local, &sub); err != nil {
			return "", err
		}
		if same(watchFolder(local, remote, sub)) == want {
			return remote, nil
		}
	}
	return "", rows.Err()
}

// watchFolder is the folder a watch's files land in, as stored (not resolved):
// the local path, plus the remote folder's name with a subfolder.
func watchFolder(localPath, remotePath string, subfolder bool) string {
	if subfolder && remotePath != "" {
		return path.Join(localPath, path.Base(remotePath))
	}
	return localPath
}

// moveFolderContents moves every entry of the old folder into the new one,
// each a rename inside the media root both lie in, then calls commit (the
// caller's database write) and removes the old folder once it is empty. A
// commit that fails puts every moved entry back. Entries the new folder already has stay where they are,
// and so does the trash folder: its rows name the copies by their place, and
// the sweep empties it where it is.
// ponytail: renames only, no copy across roots; add a copy-then-delete when a
// library spans disks and moving between them is wanted.
func (s *Server) moveFolderContents(oldRel, newRel string, commit func() error) (moveResult, error) {
	var res moveResult
	src, err := transfer.OpenLocal(s.localRoots(), oldRel)
	if err != nil {
		return res, err
	}
	defer src.Close()
	dst, err := transfer.OpenLocal(s.localRoots(), newRel)
	if err != nil {
		return res, err
	}
	defer dst.Close()
	if src.Root.Name() != dst.Root.Name() {
		return res, errMoveAcrossRoots
	}
	if src.Name == dst.Name || filepath.Clean(src.Name) == "." {
		return res, commit() // same folder, or a whole root: nothing to move
	}
	// a new folder inside the old one would swallow itself
	if rel, err := filepath.Rel(src.Name, dst.Name); err == nil && filepath.IsLocal(rel) {
		return res, errors.New("the new folder lies inside the old one")
	}
	entries, err := fs.ReadDir(src.Root.FS(), filepath.ToSlash(src.Name))
	if errors.Is(err, fs.ErrNotExist) {
		return res, commit() // nothing was downloaded yet
	}
	if err != nil {
		return res, err
	}
	// look first: what the new folder already has stays, the rest moves
	_, statErr := src.Root.Lstat(dst.Name)
	created := errors.Is(statErr, fs.ErrNotExist)
	var todo []string
	for _, e := range entries {
		if isTrashDir(e) {
			continue
		}
		if _, err := src.Root.Lstat(filepath.Join(dst.Name, e.Name())); err == nil {
			res.Kept = append(res.Kept, e.Name())
			continue
		}
		todo = append(todo, e.Name())
	}
	if err := src.Root.MkdirAll(dst.Name, 0o755); err != nil {
		return res, err
	}
	var done []string
	for _, n := range todo {
		if err := src.Root.Rename(filepath.Join(src.Name, n), filepath.Join(dst.Name, n)); err != nil {
			// a half-moved folder splits the library between two places: what
			// went is moved back, and the answer says so either way
			stuck := moveBack(src, dst, done, created)
			res.Moved = len(stuck)
			if len(stuck) == 0 {
				return res, fmt.Errorf("%s could not be moved (%w); the %d of %d entries moved before it were moved back, nothing changed",
					n, err, len(done), len(todo))
			}
			return res, fmt.Errorf("%s could not be moved (%w); %d of %d entries could not be moved back and are in the new folder: %s",
				n, err, len(stuck), len(todo), strings.Join(stuck, ", "))
		}
		done = append(done, n)
		res.Moved++
	}
	if err := commit(); err != nil {
		stuck := moveBack(src, dst, done, created)
		res.Moved = len(stuck)
		if len(stuck) == 0 {
			return res, fmt.Errorf("%w; the %d moved entries were moved back", err, len(done))
		}
		return res, fmt.Errorf("%w; %d of %d entries could not be moved back and are in the new folder: %s",
			err, len(stuck), len(done), strings.Join(stuck, ", "))
	}
	if len(res.Kept) == 0 {
		// best effort: the folder is empty now unless something wrote into it
		// (or a trash folder stays behind, until the sweep empties it)
		_ = src.Root.Remove(src.Name)
	}
	return res, nil
}
