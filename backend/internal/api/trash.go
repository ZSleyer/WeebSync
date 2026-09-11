package api

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
)

// TrashEntry is one item waiting in a trash folder: a video with its
// sidecars, or a whole folder. Path is the handle for restore and delete.
type TrashEntry struct {
	Path      string `json:"path"`      // the video or folder inside .weebsync-trash
	Name      string `json:"name"`      // its file or folder name
	Dir       string `json:"dir"`       // the folder it came from, and returns to
	IsDir     bool   `json:"isDir"`     // a whole folder copy
	Size      int64  `json:"size"`      // bytes, sidecars and folder contents included
	Files     int    `json:"files"`     // rows behind this entry: the video and its sidecars
	TrashedAt int64  `json:"trashedAt"` // unix seconds
	ExpiresAt int64  `json:"expiresAt"` // unix seconds: when the sweep deletes it
}

// TrashRequest names one trash entry by its path. An empty path on delete
// means everything.
type TrashRequest struct {
	Path string `json:"path"`
}

// trashRows lists every recorded trash path with its time, newest first.
func (s *Server) trashRows() (paths []string, at map[string]int64) {
	at = map[string]int64{}
	rows, err := s.DB.Query(`SELECT path, trashed_at FROM trash_files ORDER BY trashed_at DESC, path`)
	if err != nil {
		return nil, at
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		var t int64
		if rows.Scan(&p, &t) == nil {
			paths = append(paths, p)
			at[p] = t
		}
	}
	return paths, at
}

// trashGroup expands one entry's path to the rows it stands for: a folder or a
// non-video file is its own row, a video takes the sidecars sharing its stem
// in the same trash folder. Nil when the path is not in the table.
func (s *Server) trashGroup(path string) []string {
	paths, _ := s.trashRows()
	found := false
	for _, p := range paths {
		if p == path {
			found = true
		}
	}
	if !found {
		return nil
	}
	dir, name := filepath.Split(path)
	if !videoExt[strings.ToLower(filepath.Ext(name))] {
		return []string{path}
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name)) + "."
	group := []string{path}
	for _, p := range paths {
		d, n := filepath.Split(p)
		if p != path && d == dir && strings.HasPrefix(n, stem) && !videoExt[strings.ToLower(filepath.Ext(n))] {
			group = append(group, p)
		}
	}
	return group
}

// handleTrashList lists what waits in the trash folders, grouped like the
// restore and delete actions act: a video with its sidecars is one entry.
// A row whose file cannot be seen right now is skipped, not dropped: a media
// disk that failed to mount looks the same, and the sweep owns cleanup.
//
//	@Summary		List the trash
//	@Description	Every displaced copy waiting in a .weebsync-trash folder, newest first. A video and its sidecars form one entry.
//	@Tags			Files
//	@Produce		json
//	@Success		200	{array}		TrashEntry
//	@Failure		401	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/trash [get]
func (s *Server) handleTrashList(w http.ResponseWriter, r *http.Request) {
	paths, at := s.trashRows()
	entries := []TrashEntry{}
	index := map[string]int{} // entry position by path; the slice grows, so no pointers
	// videos and folders first, so a sidecar always finds its entry
	sort.SliceStable(paths, func(i, j int) bool {
		vi := videoExt[strings.ToLower(filepath.Ext(paths[i]))]
		vj := videoExt[strings.ToLower(filepath.Ext(paths[j]))]
		return vi && !vj
	})
	for _, p := range paths {
		local, ok := s.trashed(p)
		if !ok {
			continue
		}
		fi, err := local.Root.Stat(local.Name)
		if err != nil {
			local.Close()
			continue
		}
		size := fi.Size()
		if fi.IsDir() {
			size = 0
			fs.WalkDir(local.Root.FS(), local.Name, func(_ string, d fs.DirEntry, err error) error {
				if err == nil && d.Type().IsRegular() {
					if info, err := d.Info(); err == nil {
						size += info.Size()
					}
				}
				return nil
			})
		}
		local.Close()
		dir, name := filepath.Split(p)
		dir = filepath.Clean(dir)
		if !fi.IsDir() && !videoExt[strings.ToLower(filepath.Ext(name))] {
			// a sidecar joins the video it belongs to, when that is here too
			if i := sidecarOwner(entries, index, dir, name); i >= 0 {
				entries[i].Size += size
				entries[i].Files++
				continue
			}
		}
		e := TrashEntry{Path: p, Name: name, Dir: filepath.Dir(dir), IsDir: fi.IsDir(), Size: size, Files: 1, TrashedAt: at[p], ExpiresAt: at[p] + int64(trashTTL.Seconds())}
		index[p] = len(entries)
		entries = append(entries, e)
	}
	// entries were appended by kind; the list reads newest first
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].TrashedAt > entries[j].TrashedAt })
	writeJSON(w, http.StatusOK, entries)
}

// sidecarOwner finds the video entry in dir whose stem the sidecar name
// starts with, the longest stem winning. -1 when none is there.
func sidecarOwner(entries []TrashEntry, index map[string]int, dir, name string) int {
	best, bestLen := -1, 0
	for p, i := range index {
		e := entries[i]
		if e.IsDir || filepath.Dir(p) != dir {
			continue
		}
		stem := strings.TrimSuffix(e.Name, filepath.Ext(e.Name)) + "."
		if strings.HasPrefix(name, stem) && len(stem) > bestLen {
			best, bestLen = i, len(stem)
		}
	}
	return best
}

// handleTrashRestore moves an entry back to the folder it came from, sidecars
// with it. Nothing is overwritten: a copy in the way ends the request before
// anything moves. Admin only: the library is shared.
//
//	@Summary		Restore a trash entry
//	@Description	Moves a displaced copy (a video with its sidecars, or a folder) back beside its trash folder. Refused when something already sits there. Admin only.
//	@Tags			Files
//	@Accept			json
//	@Produce		json
//	@Param			body	body		TrashRequest	true	"Entry path"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		409		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/trash/restore [post]
func (s *Server) handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	var in TrashRequest
	if !readJSON(w, r, &in) {
		return
	}
	group := s.trashGroup(in.Path)
	if group == nil {
		writeErr(w, http.StatusNotFound, "not in the trash")
		return
	}
	// look before moving: one blocked file must not leave a half-restored set
	for _, p := range group {
		local, ok := s.trashed(p)
		if !ok {
			writeErr(w, http.StatusNotFound, "not in the trash")
			return
		}
		_, err := local.Root.Stat(restoreTarget(local.Name))
		local.Close()
		if err == nil {
			writeErr(w, http.StatusConflict, "something already sits at "+logSafe(filepath.Base(p)))
			return
		}
	}
	for _, p := range group {
		local, ok := s.trashed(p)
		if !ok {
			continue
		}
		if err := local.Root.Rename(local.Name, restoreTarget(local.Name)); err != nil {
			local.Close()
			writeErr(w, http.StatusInternalServerError, "not moved: "+logSafe(err.Error()))
			return
		}
		s.DB.Exec(`DELETE FROM trash_files WHERE path = ?`, p)
		pruneTrashDir(local, filepath.Dir(local.Name))
		local.Close()
	}
	// ponytail: the library pass re-indexes the copy; suggestions are only
	// marked stale here
	s.staleSuggestions()
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// restoreTarget is where a trashed path goes back to: the trash folder's parent.
func restoreTarget(rel string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(rel)), filepath.Base(rel))
}

// handleTrashDelete removes an entry now, ahead of the sweep, or the whole
// trash when no path is given. Admin only: the library is shared.
//
//	@Summary		Delete from the trash
//	@Description	Deletes one entry (a video with its sidecars, or a folder) for good, or everything in the trash when the path is empty. Admin only.
//	@Tags			Files
//	@Accept			json
//	@Produce		json
//	@Param			body	body		TrashRequest	false	"Entry path, empty for everything"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/trash [delete]
func (s *Server) handleTrashDelete(w http.ResponseWriter, r *http.Request) {
	var in TrashRequest
	if r.ContentLength != 0 && !readJSON(w, r, &in) {
		return
	}
	var group []string
	if in.Path == "" {
		group, _ = s.trashRows()
	} else if group = s.trashGroup(in.Path); group == nil {
		writeErr(w, http.StatusNotFound, "not in the trash")
		return
	}
	s.deleteTrash(group)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
