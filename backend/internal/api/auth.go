package api

import (
	"database/sql"
	"net/http"
	"net/mail"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// passwordAuthBlocked: in oidc-only/auto mode the password endpoints are
// disabled — but only while OIDC actually works, so a broken provider can
// never lock everyone out. Existing local users migrate automatically: the
// OIDC callback links accounts by email address.
func (s *Server) passwordAuthBlocked() bool {
	return auth.AuthMode(s.DB) != "password" && s.OIDC.Enabled()
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
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
	if auth.RegistrationDisabled(s.DB) {
		writeErr(w, http.StatusForbidden, "registration is disabled")
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash error")
		return
	}
	// first user becomes admin
	res, err := s.DB.Exec(`INSERT INTO users (email, password_hash, is_admin)
		VALUES (?, ?, (SELECT COUNT(*) = 0 FROM users))`, c.Email, hash)
	if err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	id, _ := res.LastInsertId()
	if err := auth.CreateSession(s.DB, w, r, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "email": c.Email})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	c.Email = strings.TrimSpace(strings.ToLower(c.Email))
	var id int64
	var hash string
	err := s.DB.QueryRow(`SELECT id, password_hash FROM users WHERE email = ?`, c.Email).Scan(&id, &hash)
	if err == sql.ErrNoRows || hash == "" || !auth.VerifyPassword(c.Password, hash) {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if err := auth.CreateSession(s.DB, w, r, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "email": c.Email})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	auth.DestroySession(s.DB, w, r)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, auth.UserFrom(r.Context()))
}

// handleAuthConfig tells the login page whether OIDC is available, whether
// registration is open and which auth mode is active (password | oidc-only |
// oidc-auto).
func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	mode := auth.AuthMode(s.DB)
	if !s.OIDC.Enabled() {
		mode = "password" // never lock the UI on a broken OIDC config
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"oidc":             s.OIDC.Enabled(),
		"registrationOpen": !auth.RegistrationDisabled(s.DB),
		"authMode":         mode,
	})
}
