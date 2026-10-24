package api

import (
	"net/http"
	"net/mail"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

type userInfo struct {
	ID        int64  `json:"id"`
	Email     string `json:"email"`
	IsAdmin   bool   `json:"isAdmin"`
	CreatedAt string `json:"createdAt"`
	// false while a self-registered account has not confirmed its address
	EmailVerified bool `json:"emailVerified"`
	// false while the account waits for an admin to let it in
	Approved bool `json:"approved"`
}

// userCreatedResponse is returned when a user is created.
type userCreatedResponse struct {
	ID    int64  `json:"id"`
	Email string `json:"email"`
}

// userUpdatedResponse echoes a user's role after an update.
type userUpdatedResponse struct {
	ID      int64 `json:"id"`
	IsAdmin bool  `json:"isAdmin"`
}

// handleUsersList lists all user accounts.
//
// @Summary      List users
// @Description  Lists all user accounts (admin only).
// @Tags         Users
// @Produce      json
// @Success      200  {array}   userInfo
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users [get]
func (s *Server) handleUsersList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Query(`SELECT id, email, is_admin, created_at, email_verified, approved FROM users ORDER BY id`)
	if err != nil {
		dbErr(w, err)
		return
	}
	defer rows.Close()
	users := []userInfo{}
	for rows.Next() {
		var u userInfo
		if err := rows.Scan(&u.ID, &u.Email, &u.IsAdmin, &u.CreatedAt, &u.EmailVerified, &u.Approved); err != nil {
			dbErr(w, err)
			return
		}
		users = append(users, u)
	}
	if rows.Err() != nil {
		dbErr(w, rows.Err())
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// handleUserCreate mints a password-login user account.
//
// @Summary      Create user
// @Description  Creates a password-login user account (admin only). Disabled in OIDC-only/-auto mode.
// @Tags         Users
// @Accept       json
// @Produce      json
// @Param        request  body      credentials  true  "email and password"
// @Success      201  {object}  userCreatedResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users [post]
func (s *Server) handleUserCreate(w http.ResponseWriter, r *http.Request) {
	// in an OIDC-only/-auto instance there is no password login: users onboard
	// by signing in through the identity provider, so manual creation (which
	// mints a password account) is disabled.
	mode, err := auth.AuthModeErr(s.DB)
	if err != nil {
		dbErr(w, err)
		return
	}
	if mode != "password" {
		writeErr(w, http.StatusConflict, "manual user creation is disabled in OIDC mode; users onboard via the identity provider")
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	c.Email = strings.TrimSpace(strings.ToLower(c.Email))
	parsed, err := mail.ParseAddress(c.Email)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid email")
		return
	}
	// the bare address: "Name <a@b>" stored as typed was another account for
	// the same mailbox, and never matched the address typed at sign-in
	c.Email = strings.ToLower(parsed.Address)
	if err := auth.ValidatePassword(c.Password, c.Email); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash error")
		return
	}
	// verified: the admin vouches for the address, and the account gets no
	// verification mail that could confirm it - unverified, its login was
	// refused with "email not verified" and nothing could ever change that
	res, err := s.DB.Exec(`INSERT INTO users (email, password_hash, email_verified, upgrade_dims) VALUES (?, ?, 1, 'res,sub,dub,soft')`, c.Email, hash)
	if db.IsUnique(err) {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	if err != nil {
		dbErr(w, err)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, userCreatedResponse{ID: id, Email: c.Email})
}

// userExists reports whether the given user id is present.
func (s *Server) userExists(id int64) bool {
	var one int
	return s.DB.QueryRow(`SELECT 1 FROM users WHERE id = ?`, id).Scan(&one) == nil
}

// handleUserUpdate changes a user's admin role.
//
// @Summary      Update user role
// @Description  Sets a user's admin flag (admin only). Blocked when roles are managed by OIDC, and the last admin cannot be demoted.
// @Tags         Users
// @Accept       json
// @Produce      json
// @Param        id       path      int     true  "user id"
// @Param        request  body      object  true  "isAdmin flag"
// @Success      200  {object}  userUpdatedResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users/{id} [put]
func (s *Server) handleUserUpdate(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	// when OIDC group mapping is configured, the IdP is the sole role
	// source - local role changes would be overwritten on next login
	if db.SettingOrEnv(s.DB, "oidc_admin_values", "OIDC_ADMIN_VALUES") != "" {
		writeErr(w, http.StatusConflict, "roles managed by OIDC")
		return
	}
	var body struct {
		IsAdmin bool `json:"isAdmin"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	// last-admin guard baked into the statement so check and write are
	// atomic (no TOCTOU between a COUNT and the UPDATE)
	res, err := s.DB.Exec(`UPDATE users SET is_admin = ? WHERE id = ?
		AND NOT (? = 0 AND is_admin = 1 AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) <= 1)`,
		body.IsAdmin, id, body.IsAdmin)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if s.userExists(id) {
			writeErr(w, http.StatusConflict, "cannot demote the last admin")
			return
		}
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, userUpdatedResponse{ID: id, IsAdmin: body.IsAdmin})
}

// handleUserApprove lets an account that signed itself up in.
//
// @Summary      Approve user
// @Description  Lets a self-registered or provider-created account sign in (admin only) and mails its owner. Rejecting one is deleting it.
// @Tags         Users
// @Produce      json
// @Param        id  path  int  true  "user id"
// @Success      200  {object}  OkResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users/{id}/approve [post]
func (s *Server) handleUserApprove(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	res, err := s.DB.Exec(`UPDATE users SET approved = 1 WHERE id = ? AND approved = 0`, id)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if s.userExists(id) {
			writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
			return
		}
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	s.mailApproved(id)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleUserDelete removes a user account.
//
// @Summary      Delete user
// @Description  Deletes a user account (admin only). You cannot delete yourself or the last admin.
// @Tags         Users
// @Produce      json
// @Param        id  path  int  true  "user id"
// @Success      200  {object}  OkResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/users/{id} [delete]
func (s *Server) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if me := auth.UserFrom(r.Context()); me != nil && me.ID == id {
		writeErr(w, http.StatusConflict, "cannot delete yourself")
		return
	}
	// atomic last-admin guard, same pattern as handleUserUpdate
	res, err := s.DB.Exec(`DELETE FROM users WHERE id = ?
		AND NOT (is_admin = 1 AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) <= 1)`, id)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if s.userExists(id) {
			writeErr(w, http.StatusConflict, "cannot delete the last admin")
			return
		}
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
