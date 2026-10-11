package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

// passwordChange is the body of a password change by the account itself.
type passwordChange struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

// passwordSet is the body of a password an admin sets for an account.
type passwordSet struct {
	Password string `json:"password"`
}

// writePasswordErr answers for a failed auth.SetPassword.
func writePasswordErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrWeakPassword):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, sql.ErrNoRows):
		writeErr(w, http.StatusNotFound, "user not found")
	default:
		dbErr(w)
	}
}

// handlePasswordChange lets an account change its own password.
//
// @Summary      Change own password
// @Description  Replaces the caller's password after checking the current one, and ends the caller's other sessions. An account that signs in through OIDC has no password to change.
// @Tags         Auth
// @Accept       json
// @Produce      json
// @Param        body  body      passwordChange  true  "current and new password"
// @Success      200   {object}  OkResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      401   {object}  ErrorResponse
// @Failure      403   {object}  ErrorResponse
// @Failure      429   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/auth/password [put]
func (s *Server) handlePasswordChange(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in passwordChange
	if !readJSON(w, r, &in) {
		return
	}
	var hash string
	if err := s.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, u.ID).Scan(&hash); err != nil {
		dbErr(w)
		return
	}
	// a password here would be a way in past the provider's group check,
	// the same reason an OIDC account gets no passkey
	if hash == "" {
		writeErr(w, http.StatusForbidden, "this account signs in through OIDC")
		return
	}
	// 403, not 401: the session is fine, and a 401 would sign the client out
	if !auth.VerifyPassword(in.Current, hash) {
		writeErr(w, http.StatusForbidden, "current password is wrong")
		return
	}
	if err := auth.SetPassword(s.DB, u.ID, in.New, auth.SessionToken(r)); err != nil {
		writePasswordErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleUserPassword lets an admin set a new password for an account.
//
// @Summary      Set a user's password
// @Description  Sets a new password for an account (admin only) and ends that account's sessions; your own session stays when the account is yours.
// @Tags         Users
// @Accept       json
// @Produce      json
// @Param        id    path      int          true  "user id"
// @Param        body  body      passwordSet  true  "new password"
// @Success      200   {object}  OkResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      401   {object}  ErrorResponse
// @Failure      403   {object}  ErrorResponse
// @Failure      404   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users/{id}/password [put]
func (s *Server) handleUserPassword(w http.ResponseWriter, r *http.Request) {
	var in passwordSet
	if !readJSON(w, r, &in) {
		return
	}
	if err := auth.SetPassword(s.DB, pathID(r), in.Password, auth.SessionToken(r)); err != nil {
		writePasswordErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
