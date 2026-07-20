package api

import (
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

var errNotFound = errors.New("not found")

// localRoots is the allowlist of local roots (arbitrary media mounts); empty
// falls back to the single download root.
func (s *Server) localRoots() []string {
	if len(s.LocalRoots) > 0 {
		return s.LocalRoots
	}
	return []string{s.DownloadRoot}
}

// safeLocal resolves a target path to an absolute path under one of the allowed
// roots (or, for a legacy/relative path, under the primary root).
func (s *Server) safeLocal(rel string) (string, error) {
	return transfer.ResolveLocal(s.localRoots(), rel)
}

// @Summary  Browse local directory
// @Description Lists entries in a directory under the download root.
// @Tags     Browse
// @Produce  json
// @Param    path query string false "Path relative to the download root"
// @Success  200 {array} remote.Entry
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/browse/local [get]
func (s *Server) handleBrowseLocal(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	roots := s.localRoots()
	// virtual root: with several allowed roots (media mounts), the top level
	// lists the roots themselves so the user can pick a mount
	if rel == "" && len(roots) > 1 {
		entries := make([]remote.Entry, 0, len(roots))
		for _, root := range roots {
			root = filepath.Clean(root)
			entries = append(entries, remote.Entry{
				Name:  strings.TrimPrefix(root, "/"),
				Path:  root,
				IsDir: true,
			})
		}
		writeJSON(w, http.StatusOK, entries)
		return
	}
	abs, err := s.safeLocal(rel)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		writeErr(w, http.StatusNotFound, "cannot read directory")
		return
	}
	entries := make([]remote.Entry, 0, len(items))
	for _, it := range items {
		info, err := it.Info()
		var size int64
		var mod time.Time
		if err == nil {
			size, mod = info.Size(), info.ModTime()
		}
		// single root: keep paths root-relative (legacy, breadcrumbs stay inside
		// the root). Multi-root: absolute container paths so a chosen mount is
		// unambiguous.
		p := path.Join("/", rel, it.Name())
		if len(roots) > 1 {
			p = path.Join(abs, it.Name())
		}
		entries = append(entries, remote.Entry{
			Name:    it.Name(),
			Path:    p,
			Size:    size,
			IsDir:   it.IsDir(),
			ModTime: mod,
		})
	}
	writeJSON(w, http.StatusOK, entries)
}

// MkdirLocalRequest is the body of handleMkdirLocal.
type MkdirLocalRequest struct {
	Path string `json:"path"`
}

// @Summary  Create local directory
// @Description Creates a directory (and parents) under the download root.
// @Tags     Browse
// @Accept   json
// @Produce  json
// @Param    body body MkdirLocalRequest true "Directory path relative to the download root"
// @Success  201 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/browse/local/mkdir [post]
func (s *Server) handleMkdirLocal(w http.ResponseWriter, r *http.Request) {
	var in MkdirLocalRequest
	if !readJSON(w, r, &in) {
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "mkdir failed")
		return
	}
	writeJSON(w, http.StatusCreated, OkResponse{Status: "ok"})
}

// isLocalRoot reports whether abs is one of the allowed roots itself. Renaming
// or deleting a root would wipe (or move out of) a whole media mount, and
// ResolveLocal happily maps ".." back onto the root, so both writers check it.
func (s *Server) isLocalRoot(abs string) bool {
	for _, root := range s.localRoots() {
		if abs == filepath.Clean(root) {
			return true
		}
	}
	return false
}

// RenameLocalRequest is the body of handleRenameLocal.
type RenameLocalRequest struct {
	Path string `json:"path"` // entry to rename, under an allowed root
	Name string `json:"name"` // new base name, no path separators
}

// @Summary  Rename local entry
// @Description Renames a file or directory under the download root. Admin only.
// @Tags     Browse
// @Accept   json
// @Produce  json
// @Param    body body RenameLocalRequest true "Entry path and new name"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/browse/local/rename [post]
func (s *Server) handleRenameLocal(w http.ResponseWriter, r *http.Request) {
	var in RenameLocalRequest
	if !readJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	// a plain base name only: anything with a separator (or a dot entry) could
	// move the file out of its folder, even though safeLocal would still keep
	// it inside a root
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		writeErr(w, http.StatusBadRequest, "invalid name")
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.isLocalRoot(abs) {
		writeErr(w, http.StatusBadRequest, "cannot rename a root")
		return
	}
	// abs is already inside a root and name carries no separator, so staying in
	// the same directory keeps the result inside that root too - resolving the
	// target through safeLocal again would re-anchor it at the root
	dst := filepath.Join(filepath.Dir(abs), name)
	if _, err := os.Lstat(dst); err == nil {
		writeErr(w, http.StatusConflict, "target exists")
		return
	}
	if err := os.Rename(abs, dst); err != nil {
		writeErr(w, http.StatusInternalServerError, "rename failed")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// DeleteLocalRequest is the body of handleDeleteLocal.
type DeleteLocalRequest struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"` // required to delete a non-empty directory
}

// @Summary  Delete local entry
// @Description Deletes a file or directory under the download root. A non-empty directory needs recursive=true. Admin only.
// @Tags     Browse
// @Accept   json
// @Produce  json
// @Param    body body DeleteLocalRequest true "Entry path and recursive flag"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/browse/local [delete]
func (s *Server) handleDeleteLocal(w http.ResponseWriter, r *http.Request) {
	var in DeleteLocalRequest
	if !readJSON(w, r, &in) {
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.isLocalRoot(abs) {
		writeErr(w, http.StatusBadRequest, "cannot delete a root")
		return
	}
	if in.Recursive {
		err = os.RemoveAll(abs)
	} else {
		// plain Remove fails on a non-empty directory, which is the point:
		// wiping a folder full of episodes has to be asked for explicitly
		err = os.Remove(abs)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// @Summary  Browse remote directory
// @Description Lists entries in a directory on the given remote server. Defaults to the server root when no path is given.
// @Tags     Browse
// @Produce  json
// @Param    id   path  int    true  "Server ID"
// @Param    path query string false "Remote directory path"
// @Success  200 {array} remote.Entry
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id}/browse [get]
func (s *Server) handleBrowseRemote(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	client, rootPath, err := s.DialServer(u.ID, id)
	if err != nil {
		status := http.StatusBadGateway
		if err == errNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	defer client.Close()
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = rootPath
	}
	entries, err := client.List(dir)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	go s.indexDir(id, dir, entries) // free index feed, no extra remote requests
	writeJSON(w, http.StatusOK, entries)
}
