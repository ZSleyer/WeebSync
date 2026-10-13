package api

import (
	"net/http"
	"regexp"

	"github.com/ch4d1/weebsync/internal/auth"
)

// tipKeyRe is the shape of a hint's key. The frontend picks the names, so the
// backend keeps no list of them; it only refuses what no hint would be called.
var tipKeyRe = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

// TipsResponse lists the hints the caller has closed.
type TipsResponse struct {
	Dismissed []string `json:"dismissed"`
}

// TipDismissRequest is the body of POST /api/auth/tips/dismiss.
type TipDismissRequest struct {
	Key string `json:"key" example:"install-pwa"`
}

// handleTipsGet lists the hints the caller has closed.
//
//	@Summary		List dismissed UI hints
//	@Tags			Tips
//	@Produce		json
//	@Success		200	{object}	TipsResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/tips [get]
func (s *Server) handleTipsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT tip_key FROM user_tips WHERE user_id = ? ORDER BY tip_key`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	out := TipsResponse{Dismissed: []string{}}
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil {
			out.Dismissed = append(out.Dismissed, k)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleTipDismiss closes a hint for the caller, on every device. Closing one
// twice is fine.
//
//	@Summary		Dismiss a UI hint
//	@Tags			Tips
//	@Accept			json
//	@Produce		json
//	@Param			body	body	TipDismissRequest	true	"Hint to dismiss"
//	@Success		200	{object}	OkResponse
//	@Failure		400	{object}	ErrorResponse
//	@Failure		415	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/tips/dismiss [post]
func (s *Server) handleTipDismiss(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in TipDismissRequest
	if !readJSONLimit(w, r, &in, 1<<10) {
		return
	}
	if !tipKeyRe.MatchString(in.Key) {
		writeErr(w, http.StatusBadRequest, "invalid tip key")
		return
	}
	if _, err := s.DB.Exec(`INSERT OR IGNORE INTO user_tips (user_id, tip_key) VALUES (?, ?)`, u.ID, in.Key); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
