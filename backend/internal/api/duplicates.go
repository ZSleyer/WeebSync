package api

import (
	"context"
	"fmt"
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

// DuplicateTrashRequest is the body of handleDuplicateTrash.
type DuplicateTrashRequest struct {
	Path string `json:"path"` // local folder or file from a duplicate card
}

// handleDuplicateTrash moves one copy of a duplicate (a whole folder, or one
// file of a doubled episode) into the trash folder beside it, where the sweep
// deletes it after the grace period. Admin only: the library is shared.
//
//	@Summary		Trash a duplicate copy
//	@Description	Moves a local folder or file from the duplicates view into a .weebsync-trash folder next to it; the sweep deletes it after 14 days. Admin only.
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			body	body		DuplicateTrashRequest	true	"Local path"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions/duplicates/trash [post]
func (s *Server) handleDuplicateTrash(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in DuplicateTrashRequest
	if !readJSON(w, r, &in) {
		return
	}
	abs, err := s.safeLocal(in.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.isLocalRoot(abs) {
		writeErr(w, http.StatusBadRequest, "cannot trash a root")
		return
	}
	if err := s.trashPath(abs); err != nil {
		writeErr(w, http.StatusNotFound, "not moved: "+logSafe(err.Error()))
		return
	}
	// the index still lists the folder until the next library pass; without
	// this the rebuild below shows the duplicate again
	s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = 0 AND (folder = ? OR folder LIKE ? || '/%')`, in.Path, in.Path)
	// every user's suggestions counted that copy
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%'`)
	uid := u.ID
	key := fmt.Sprintf("suggestions:%d", uid)
	s.runJob(key, func(ctx context.Context) { s.buildUserSuggestions(ctx, uid) })
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
