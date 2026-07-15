// Package api wires all HTTP handlers.
package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

type Server struct {
	DB   *sql.DB
	OIDC *auth.OIDC
	// DownloadRoot is the base directory all local file operations are jailed to.
	DownloadRoot string
}

func (s *Server) Register(mux *http.ServeMux) {
	authed := auth.Middleware(s.DB, true)

	// auth
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.Handle("GET /api/auth/me", authed(http.HandlerFunc(s.handleMe)))
	mux.HandleFunc("GET /api/auth/config", s.handleAuthConfig)
	if s.OIDC != nil {
		mux.HandleFunc("GET /api/auth/oidc/login", s.OIDC.LoginHandler)
		mux.HandleFunc("GET /api/auth/oidc/callback", s.OIDC.CallbackHandler(s.DB))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON", "err", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}
