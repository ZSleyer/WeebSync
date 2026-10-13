package api

import (
	"errors"
	"io/fs"
	"path"
	"path/filepath"

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

// watchFolder is the folder a watch's files land in, as stored (not resolved):
// the local path, plus the remote folder's name with a subfolder.
func watchFolder(localPath, remotePath string, subfolder bool) string {
	if subfolder && remotePath != "" {
		return path.Join(localPath, path.Base(remotePath))
	}
	return localPath
}

// moveFolderContents moves every entry of the old folder into the new one,
// each a rename inside the media root both lie in, and removes the old folder
// once it is empty. Entries the new folder already has stay where they are.
// ponytail: renames only, no copy across roots; add a copy-then-delete when a
// library spans disks and moving between them is wanted.
func (s *Server) moveFolderContents(oldRel, newRel string) (moveResult, error) {
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
		return res, nil // same folder, or a whole root: nothing to move
	}
	// a new folder inside the old one would swallow itself
	if rel, err := filepath.Rel(src.Name, dst.Name); err == nil && filepath.IsLocal(rel) {
		return res, errors.New("the new folder lies inside the old one")
	}
	entries, err := fs.ReadDir(src.Root.FS(), filepath.ToSlash(src.Name))
	if errors.Is(err, fs.ErrNotExist) {
		return res, nil // nothing was downloaded yet
	}
	if err != nil {
		return res, err
	}
	if err := src.Root.MkdirAll(dst.Name, 0o755); err != nil {
		return res, err
	}
	for _, e := range entries {
		to := filepath.Join(dst.Name, e.Name())
		if _, err := src.Root.Lstat(to); err == nil {
			res.Kept = append(res.Kept, e.Name())
			continue
		}
		if err := src.Root.Rename(filepath.Join(src.Name, e.Name()), to); err != nil {
			return res, err
		}
		res.Moved++
	}
	if len(res.Kept) == 0 {
		// best effort: the folder is empty now unless something wrote into it
		_ = src.Root.Remove(src.Name)
	}
	return res, nil
}
