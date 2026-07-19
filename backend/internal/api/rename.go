package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/rename"
)

type renamePair struct {
	Old string `json:"old"`
	New string `json:"new"`
	Err string `json:"error,omitempty"`
}

// handleRenamePreview lists files in a local directory and returns the
// dry-run mapping old → new. Nothing is renamed here.
//
// @Summary      Preview renames for a directory
// @Description  Lists files in a local directory and returns the dry-run old→new mapping for the given rename options. Nothing is renamed.
// @Tags         Rename
// @Accept       json
// @Produce      json
// @Param        body  body  object  true  "Directory path (relative to the download root) and rename options"
// @Success      200  {array}   renamePair
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/rename/preview [post]
func (s *Server) handleRenamePreview(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"` // directory relative to download root
		rename.Options
	}
	if !readJSON(w, r, &in) {
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		writeErr(w, http.StatusNotFound, "cannot read directory")
		return
	}
	pairs := []renamePair{}
	for _, it := range items {
		if it.IsDir() {
			continue
		}
		p := renamePair{Old: it.Name()}
		if newName, err := rename.New(it.Name(), in.Options); err != nil {
			p.New, p.Err = it.Name(), err.Error()
		} else {
			p.New = newName
		}
		pairs = append(pairs, p)
	}
	writeJSON(w, http.StatusOK, pairs)
}

// handleRenameNames dry-runs rename options against a plain list of names,
// no filesystem involved (watch preview: the names come from a remote folder).
//
// @Summary      Preview renames for a name list
// @Description  Dry-runs the rename options against a plain list of names (no filesystem access); used to preview a watch's rename rule. At most 100 names are processed.
// @Tags         Rename
// @Accept       json
// @Produce      json
// @Param        body  body  object  true  "Names to test plus rename options"
// @Success      200  {array}   renamePair
// @Failure      400  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/rename/names [post]
func (s *Server) handleRenameNames(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Names           []string `json:"names"`
		ServerID        int64    `json:"serverId"`
		RemotePath      string   `json:"remotePath"`
		LocalPath       string   `json:"localPath"`
		AiredMapping    bool     `json:"airedMapping"`
		RenameProvider  string   `json:"renameProvider"`
		RenameOrdering  string   `json:"renameOrdering"`
		RenameTitleLang string   `json:"renameTitleLang"`
		RenameSeriesID  int      `json:"renameSeriesId"`
		rename.Options
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Names) > 100 {
		in.Names = in.Names[:100]
	}
	// build the same name function the sync uses, so the preview reflects the
	// aired-order mapping and the localized provider title exactly
	fn := s.watchNameFn(Watch{
		UserID: u.ID, ServerID: in.ServerID, RemotePath: in.RemotePath, LocalPath: in.LocalPath,
		Mode: in.Mode, Template: in.Template, Separator: in.Separator, TitleOverride: in.TitleOverride,
		Pattern: in.Pattern, Replacement: in.Replacement,
		AiredMapping: in.AiredMapping, RenameProvider: in.RenameProvider, RenameOrdering: in.RenameOrdering,
		RenameTitleLang: in.RenameTitleLang, RenameSeriesID: in.RenameSeriesID,
	})
	pairs := []renamePair{}
	for _, name := range in.Names {
		p := renamePair{Old: name}
		if fn == nil {
			p.New = name
		} else if nn := fn(name); nn != name {
			p.New = nn
		} else if _, err := rename.New(name, in.Options); err != nil {
			// unchanged: surface why the base template couldn't apply
			p.New, p.Err = name, err.Error()
		} else {
			p.New = nn
		}
		pairs = append(pairs, p)
	}
	writeJSON(w, http.StatusOK, pairs)
}

// handleRenameApply performs the given renames inside one directory.
//
// @Summary      Apply renames in a directory
// @Description  Performs the given old→new renames inside one directory (jailed to the download root). Returns the per-file result; entries that failed carry an error.
// @Tags         Rename
// @Accept       json
// @Produce      json
// @Param        body  body  object  true  "Directory path and the list of old→new renames to apply"
// @Success      200  {array}   renamePair
// @Failure      400  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/rename/apply [post]
func (s *Server) handleRenameApply(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path    string       `json:"path"`
		Renames []renamePair `json:"renames"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	results := []renamePair{}
	for _, p := range in.Renames {
		// names must stay inside the directory
		if p.Old == "" || p.New == "" || strings.ContainsAny(p.Old+p.New, "/\\") ||
			p.Old == ".." || p.New == ".." {
			p.Err = "invalid name"
			results = append(results, p)
			continue
		}
		if p.Old == p.New {
			results = append(results, p)
			continue
		}
		dst := filepath.Join(abs, p.New)
		if _, err := os.Stat(dst); err == nil {
			p.Err = "target exists"
			results = append(results, p)
			continue
		}
		if err := os.Rename(filepath.Join(abs, p.Old), dst); err != nil {
			p.Err = err.Error()
		}
		results = append(results, p)
	}
	writeJSON(w, http.StatusOK, results)
}
