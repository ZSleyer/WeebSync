package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// dismissRequest ignores (or, on DELETE, restores) one suggestion for the user.
type dismissRequest struct {
	Kind   string `json:"kind"`   // "suggestion" | "upgrade"
	RefKey string `json:"refKey"` // stable id: "series:42" or "source:media_id"
	Label  string `json:"label"`  // display title, for the restore list
	// Cover is the item's picture and Section the list it was hidden from
	// (a page's own name for it, "watchlist", "upgrades"), both only for the
	// restore list; optional.
	Cover   string `json:"cover,omitempty"`
	Section string `json:"section,omitempty"`
}

// DismissedItem is one row of the ignore list.
type DismissedItem struct {
	Kind        string `json:"kind"`
	RefKey      string `json:"refKey"`
	Label       string `json:"label"`
	DismissedAt string `json:"dismissedAt"`
	// Cover and Section as the client sent them on hiding; empty for items
	// hidden before they were kept
	Cover   string `json:"cover"`
	Section string `json:"section"`
}

// dismissCover keeps a cover only when it is a web address: it is put into
// an img src on the restore list, so nothing else gets through.
func dismissCover(u string) string {
	u = strings.TrimSpace(u)
	if len(u) > 2048 || !(strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")) {
		return ""
	}
	return u
}

// dismissSection keeps a short identifier and nothing else.
func dismissSection(v string) string {
	if len(v) > 32 {
		return ""
	}
	for _, r := range v {
		if (r < 'a' || r > 'z') && r != '-' && r != '_' {
			return ""
		}
	}
	return v
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
	_ = rows.Err() // a cut-off read hides fewer suggestions, never more
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
//	@Failure		500	{object}	ErrorResponse
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
	if _, err := s.DB.Exec(`INSERT OR REPLACE INTO suggestion_dismissals (user_id, kind, ref_key, label, dismissed_at, cover, section)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, u.ID, in.Kind, in.RefKey, in.Label, time.Now().UTC().Format(time.RFC3339),
		dismissCover(in.Cover), dismissSection(in.Section)); err != nil {
		dbErr(w, err)
		return
	}
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
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions/dismiss [delete]
func (s *Server) handleDismissRestore(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in dismissRequest
	if !readJSON(w, r, &in) {
		return
	}
	if _, err := s.DB.Exec(`DELETE FROM suggestion_dismissals WHERE user_id = ? AND kind = ? AND ref_key = ?`,
		u.ID, in.Kind, in.RefKey); err != nil {
		dbErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleDismissedList returns the user's ignore list, newest first.
//
//	@Summary		List ignored suggestions
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}	DismissedItem
//	@Failure		500		{object}		ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions/dismissed [get]
func (s *Server) handleDismissedList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT kind, ref_key, label, dismissed_at, cover, section FROM suggestion_dismissals
		WHERE user_id = ? ORDER BY dismissed_at DESC`, u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	defer rows.Close()
	out := []DismissedItem{}
	for rows.Next() {
		var d DismissedItem
		if rows.Scan(&d.Kind, &d.RefKey, &d.Label, &d.DismissedAt, &d.Cover, &d.Section) == nil {
			out = append(out, d)
		}
	}
	if rows.Err() != nil {
		dbErr(w, rows.Err())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
