package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

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
	case errors.Is(err, auth.ErrWeakPassword), errors.Is(err, auth.ErrCommonPassword):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, sql.ErrNoRows):
		writeErr(w, http.StatusNotFound, "user not found")
	case errors.Is(err, auth.ErrHashBusy):
		hashBusy(w)
	default:
		dbErr(w, err)
	}
}

// hashBusy answers a request that found every password hashing slot taken
// (see auth.ErrHashBusy): the server is overloaded, not the input wrong.
func hashBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeErr(w, http.StatusServiceUnavailable, auth.ErrHashBusy.Error())
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
// @Failure      503   {object}  ErrorResponse
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
		dbErr(w, err)
		return
	}
	// a password here would be a way in past the provider's group check,
	// the same reason an OIDC account gets no passkey
	if hash == "" {
		writeErr(w, http.StatusForbidden, "this account signs in through OIDC")
		return
	}
	// 403, not 401: the session is fine, and a 401 would sign the client out
	if !s.checkPassword(w, r, u.Email, in.Current, hash, "current password is wrong") {
		return
	}
	if err := auth.SetPasswordContext(r.Context(), s.DB, u.ID, in.New, auth.SessionToken(r)); err != nil {
		writePasswordErr(w, err)
		return
	}
	s.securityNotice(r, u.ID, noticePasswordChanged)
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
// @Failure      503   {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users/{id}/password [put]
func (s *Server) handleUserPassword(w http.ResponseWriter, r *http.Request) {
	var in passwordSet
	if !readJSON(w, r, &in) {
		return
	}
	if err := auth.SetPasswordContext(r.Context(), s.DB, pathID(r), in.Password, auth.SessionToken(r)); err != nil {
		writePasswordErr(w, err)
		return
	}
	s.securityNotice(r, pathID(r), noticePasswordAdmin)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// passwordForgot asks for a reset link.
type passwordForgot struct {
	Email string `json:"email"`
}

// passwordReset sets a new password with the token from a reset link.
type passwordReset struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// resetHash is what the database keeps of a reset token: a copy of the
// database then hands nobody a working link.
func resetHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// passwordResetReady reports whether a reset link can go out at all: it
// needs a mail server and the public address the link points to.
func (s *Server) passwordResetReady() bool {
	return s.Mail != nil && s.Mail.Configured() && s.baseURL() != "" && !s.passwordAuthBlocked()
}

// handlePasswordForgot mails a reset link to an account with a password.
//
// @Summary      Ask for a password reset link
// @Description  Mails a link to set a new password, good for an hour and once. Answers the same whether or not the address has an account, so it tells nobody which addresses do; at most one mail per account every five minutes. Accounts that sign in through OIDC get none.
// @Tags         Auth
// @Accept       json
// @Produce      json
// @Param        body  body      passwordForgot  true  "account email"
// @Success      200   {object}  OkResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      429   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Failure      503   {object}  ErrorResponse
// @Router       /api/auth/forgot [post]
func (s *Server) handlePasswordForgot(w http.ResponseWriter, r *http.Request) {
	var in passwordForgot
	if !readJSON(w, r, &in) {
		return
	}
	if !s.passwordResetReady() {
		writeErr(w, http.StatusServiceUnavailable, "password reset by mail is not set up")
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	token := randToken()
	res, err := s.DB.Exec(`UPDATE users SET reset_token_hash = ?, reset_sent_at = datetime('now')
		WHERE email = ? AND password_hash != ''
		AND (reset_sent_at = '' OR reset_sent_at <= datetime('now', '-5 minutes'))`, resetHash(token), email)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 1 {
		var locale string
		_ = s.DB.QueryRow(`SELECT locale FROM users WHERE email = ?`, email).Scan(&locale) // the mail goes out in English
		s.spawn(func() { s.sendResetEmail(email, token, locale) })
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handlePasswordReset sets a new password with a reset link's token.
//
// @Summary      Set a new password from a reset link
// @Description  Consumes the token of a reset link (good for an hour and once), sets the new password and ends the account's sessions.
// @Tags         Auth
// @Accept       json
// @Produce      json
// @Param        body  body      passwordReset  true  "token and new password"
// @Success      200   {object}  OkResponse
// @Failure      400   {object}  ErrorResponse
// @Failure      403   {object}  ErrorResponse
// @Failure      429   {object}  ErrorResponse
// @Failure      500   {object}  ErrorResponse
// @Failure      503   {object}  ErrorResponse
// @Router       /api/auth/reset [post]
func (s *Server) handlePasswordReset(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	var in passwordReset
	if !readJSON(w, r, &in) {
		return
	}
	var id int64
	err := s.DB.QueryRow(`SELECT id FROM users WHERE reset_token_hash = ? AND reset_token_hash != ''
		AND reset_sent_at > datetime('now', '-1 hour') AND password_hash != ''`, resetHash(in.Token)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) || in.Token == "" {
		writeErr(w, http.StatusBadRequest, "this reset link is invalid or has expired")
		return
	}
	if err != nil {
		dbErr(w, err)
		return
	}
	// clears the token with the old password, in one go
	if err := auth.SetPasswordContext(r.Context(), s.DB, id, in.Password, ""); err != nil {
		writePasswordErr(w, err)
		return
	}
	s.securityNotice(r, id, noticePasswordReset)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
