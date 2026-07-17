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
)

var errNotFound = errors.New("not found")

// safeLocal resolves rel against the download root and rejects escapes.
func (s *Server) safeLocal(rel string) (string, error) {
	abs := filepath.Join(s.DownloadRoot, filepath.Clean("/"+rel))
	root := filepath.Clean(s.DownloadRoot)
	if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", errors.New("path escapes download root")
	}
	return abs, nil
}

func (s *Server) handleBrowseLocal(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
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
		entries = append(entries, remote.Entry{
			Name:    it.Name(),
			Path:    path.Join("/", rel, it.Name()),
			Size:    size,
			IsDir:   it.IsDir(),
			ModTime: mod,
		})
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleMkdirLocal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
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
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

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
