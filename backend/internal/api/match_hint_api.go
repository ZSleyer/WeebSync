package api

import (
	"net/http"
	"path"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// hintDismissRequest is the body of handleCatalogHintDismiss.
type hintDismissRequest struct {
	Folder string `json:"folder"`
}

// handleCatalogHintDismiss drops a folder's TMDB hint for good: the sweep
// does not offer one for the folder again.
//
//	@Summary		Dismiss match hint
//	@Description	Drop the TMDB hint offered for an unmatched folder; it is not offered again.
//	@Tags			Catalog
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int					true	"Server id"
//	@Param			body	body		hintDismissRequest	true	"Folder"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/hint/dismiss [post]
func (s *Server) handleCatalogHintDismiss(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	if localCurateDenied(w, u, serverID) {
		return
	}
	var in hintDismissRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.Folder == "" || path.Clean(in.Folder) != in.Folder {
		writeErr(w, http.StatusBadRequest, "invalid folder")
		return
	}
	if serverID != localServerID {
		var owned int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned); err != nil {
			dbErr(w)
			return
		}
		if owned == 0 {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
	}
	if _, err := s.DB.Exec(`UPDATE match_hints SET state = 'dismissed', checked_at = ? WHERE server_id = ? AND folder = ?`,
		time.Now().Unix(), serverID, in.Folder); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
