package api

import (
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/nssteinbrenner/anitogo"
)

func (s *Server) handleAnilistSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "q required")
		return
	}
	list, err := s.Anilist.Search(r.Context(), q)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleAnilistMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	m, err := s.Anilist.Media(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

type catalogItem struct {
	Entry remote.Entry   `json:"entry"`
	Media *anilist.Media `json:"media,omitempty"`
}

// GuessTitle extracts a searchable series title from a release folder/file name.
func GuessTitle(name string) string {
	parsed := anitogo.Parse(name, anitogo.DefaultOptions)
	if parsed.AnimeTitle != "" {
		return parsed.AnimeTitle
	}
	return strings.TrimSpace(name)
}

// handleCatalog lists remote folders enriched with AniList metadata.
// Matches are cached in catalog_matches; unmatched folders are looked up
// on the fly (rate-limited) and persisted.
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	client, rootPath, err := s.DialServer(u.ID, serverID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
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

	items := []catalogItem{}
	for _, e := range entries {
		if !e.IsDir {
			continue
		}
		item := catalogItem{Entry: e}
		var mediaID int
		err := s.DB.QueryRow(`SELECT media_id FROM catalog_matches WHERE server_id = ? AND folder = ?`,
			serverID, e.Path).Scan(&mediaID)
		if err != nil {
			// no match yet: guess and search
			if results, serr := s.Anilist.Search(r.Context(), GuessTitle(e.Name)); serr == nil && len(results) > 0 {
				mediaID = results[0].ID
			}
			s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual) VALUES (?, ?, ?, 0)`,
				serverID, e.Path, mediaID)
		}
		if mediaID != 0 {
			if m, merr := s.Anilist.Media(r.Context(), mediaID); merr == nil {
				item.Media = m
			}
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

// handleCatalogMatch sets or clears a manual folder→media match.
func (s *Server) handleCatalogMatch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in struct {
		Folder  string `json:"folder"`
		MediaID int    `json:"mediaId"` // 0 = unmatch
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Folder == "" || path.Clean(in.Folder) != in.Folder {
		writeErr(w, http.StatusBadRequest, "invalid folder")
		return
	}
	// ownership check: the server must belong to the user
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual) VALUES (?, ?, ?, 1)`,
		serverID, in.Folder, in.MediaID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
