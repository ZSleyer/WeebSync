package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ch4d1/weebsync/internal/rename"
)

type renamePair struct {
	Old string `json:"old"`
	New string `json:"new"`
	Err string `json:"error,omitempty"`
}

// handleRenamePreview lists files in a local directory and returns the
// dry-run mapping old → new. Nothing is renamed here.
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

// handleRenameApply performs the given renames inside one directory.
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
