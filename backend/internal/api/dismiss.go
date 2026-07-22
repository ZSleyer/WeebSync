package api

import (
	"net/http"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// dismissRequest ignores (or, on DELETE, restores) one suggestion for the user.
type dismissRequest struct {
	Kind   string `json:"kind"`   // "suggestion" | "upgrade"
	RefKey string `json:"refKey"` // stable id: "series:42" or "source:media_id"
	Label  string `json:"label"`  // display title, for the restore list
}

// DismissedItem is one row of the ignore list.
type DismissedItem struct {
	Kind        string `json:"kind"`
	RefKey      string `json:"refKey"`
	Label       string `json:"label"`
	DismissedAt string `json:"dismissedAt"`
}

// dismissedKeys returns the ref keys a user has ignored for a kind, for
// filtering suggestion lists.
func (s *Server) dismissedKeys(userID int64, kind string) map[string]bool {
	out := map[string]bool{}
	rows, err := s.DB.Query(`SELECT ref_key FROM suggestion_dismissals WHERE user_id = ? AND kind = ?`, userID, kind)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil {
			out[k] = true
		}
	}
	return out
}

// handleDismiss ignores a suggestion.
//
//	@Summary		Ignore a suggestion
//	@Tags			Suggestions
//	@Accept			json
//	@Param			body	body	dismissRequest	true	"Item to ignore"
//	@Success		200	{object}	OkResponse
//	@Failure		415	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions/dismiss [post]
func (s *Server) handleDismiss(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in dismissRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.Kind == "" || in.RefKey == "" {
		writeErr(w, http.StatusBadRequest, "kind and refKey required")
		return
	}
	s.DB.Exec(`INSERT OR REPLACE INTO suggestion_dismissals (user_id, kind, ref_key, label, dismissed_at)
		VALUES (?, ?, ?, ?, ?)`, u.ID, in.Kind, in.RefKey, in.Label, time.Now().UTC().Format(time.RFC3339))
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleDismissRestore removes an item from the ignore list.
//
//	@Summary		Restore an ignored suggestion
//	@Tags			Suggestions
//	@Accept			json
//	@Param			body	body	dismissRequest	true	"Item to restore (kind + refKey)"
//	@Success		200	{object}	OkResponse
//	@Failure		415	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions/dismiss [delete]
func (s *Server) handleDismissRestore(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in dismissRequest
	if !readJSON(w, r, &in) {
		return
	}
	s.DB.Exec(`DELETE FROM suggestion_dismissals WHERE user_id = ? AND kind = ? AND ref_key = ?`,
		u.ID, in.Kind, in.RefKey)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleDismissedList returns the user's ignore list, newest first.
//
//	@Summary		List ignored suggestions
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}	DismissedItem
//	@Security		CookieAuth
//	@Router			/api/suggestions/dismissed [get]
func (s *Server) handleDismissedList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT kind, ref_key, label, dismissed_at FROM suggestion_dismissals
		WHERE user_id = ? ORDER BY dismissed_at DESC`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	out := []DismissedItem{}
	for rows.Next() {
		var d DismissedItem
		if rows.Scan(&d.Kind, &d.RefKey, &d.Label, &d.DismissedAt) == nil {
			out = append(out, d)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
