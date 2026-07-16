package api

import (
	"net/http"
	"net/mail"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

type userInfo struct {
	ID        int64  `json:"id"`
	Email     string `json:"email"`
	IsAdmin   bool   `json:"isAdmin"`
	CreatedAt string `json:"createdAt"`
}

func (s *Server) handleUsersList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Query(`SELECT id, email, is_admin, created_at FROM users ORDER BY id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	users := []userInfo{}
	for rows.Next() {
		var u userInfo
		if err := rows.Scan(&u.ID, &u.Email, &u.IsAdmin, &u.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		users = append(users, u)
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleUserCreate(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	c.Email = strings.TrimSpace(strings.ToLower(c.Email))
	if _, err := mail.ParseAddress(c.Email); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid email")
		return
	}
	if err := auth.ValidatePassword(c.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash error")
		return
	}
	res, err := s.DB.Exec(`INSERT INTO users (email, password_hash) VALUES (?, ?)`, c.Email, hash)
	if err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "email": c.Email})
}

// userExists reports whether the given user id is present.
func (s *Server) userExists(id int64) bool {
	var one int
	return s.DB.QueryRow(`SELECT 1 FROM users WHERE id = ?`, id).Scan(&one) == nil
}

func (s *Server) handleUserUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	// when OIDC group mapping is configured, the IdP is the sole role
	// source — local role changes would be overwritten on next login
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
		writeErr(w, http.StatusInternalServerError, "db error")
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
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "isAdmin": body.IsAdmin})
}

func (s *Server) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	if me := auth.UserFrom(r.Context()); me != nil && me.ID == id {
		writeErr(w, http.StatusConflict, "cannot delete yourself")
		return
	}
	// atomic last-admin guard, same pattern as handleUserUpdate
	res, err := s.DB.Exec(`DELETE FROM users WHERE id = ?
		AND NOT (is_admin = 1 AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) <= 1)`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
