package api

import (
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

// Writes to AniList are opt-in per user: nothing changes on the account
// until its owner turns the matching switch on in the settings. Reading
// stays available to every linked account.

// AnilistPermissions are a user's AniList write switches.
type AnilistPermissions struct {
	// List: status, progress, score and removal of list entries, and the
	// watched-episode step from the suggestions page and the player
	List bool `json:"list"`
	// Social: replies and likes in forum threads
	Social bool `json:"social"`
}

// write kinds, each behind its own switch
const (
	writeList   = "list"
	writeSocial = "social"
)

// anilistPerms reads a user's switches; a missing row reads as all off.
func (s *Server) anilistPerms(userID int64) AnilistPermissions {
	var p AnilistPermissions
	// fails closed: an unreadable row leaves every switch off
	_ = s.DB.QueryRow(`SELECT anilist_write_list, anilist_write_social FROM users WHERE id = ?`, userID).
		Scan(&p.List, &p.Social)
	return p
}

// anilistWriter resolves the linked account for a write of the given kind
// and checks the user allowed it, answering the request itself when not:
// 400 without a linked account, 403 with the switch off. Every write handler
// calls it before it talks to AniList.
func (s *Server) anilistWriter(w http.ResponseWriter, userID int64, kind string) (alID int, token string, ok bool) {
	alID, token, err := s.anilistAccount(userID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return 0, "", false
	}
	p := s.anilistPerms(userID)
	switch {
	case kind == writeList && !p.List:
		writeErr(w, http.StatusForbidden, "changing the AniList list from WeebSync is turned off in the settings")
		return 0, "", false
	case kind == writeSocial && !p.Social:
		writeErr(w, http.StatusForbidden, "replying and liking on AniList from WeebSync is turned off in the settings")
		return 0, "", false
	}
	return alID, token, true
}

// anilistPermissionsRequest changes one or both switches; absent ones stay.
type anilistPermissionsRequest struct {
	List   *bool `json:"list,omitempty"`
	Social *bool `json:"social,omitempty"`
}

// handleAnilistPermissions sets the user's AniList write switches.
//
//	@Summary		AniList write permissions
//	@Description	Turn the user's AniList write switches on or off: list (status, progress, score, removal) and social (replies, likes). Both are off by default.
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			body	body		anilistPermissionsRequest	true	"Switches to change"
//	@Success		200		{object}	AnilistPermissions
//	@Failure		400		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/permissions [put]
func (s *Server) handleAnilistPermissions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in anilistPermissionsRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.List != nil {
		if _, err := s.DB.Exec(`UPDATE users SET anilist_write_list = ? WHERE id = ?`, *in.List, u.ID); err != nil {
			dbErr(w, err)
			return
		}
	}
	if in.Social != nil {
		if _, err := s.DB.Exec(`UPDATE users SET anilist_write_social = ? WHERE id = ?`, *in.Social, u.ID); err != nil {
			dbErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.anilistPerms(u.ID))
}
