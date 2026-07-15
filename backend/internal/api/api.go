// Package api wires all HTTP handlers.
package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/transfer"
)

type Server struct {
	DB   *sql.DB
	OIDC *auth.OIDC
	// DownloadRoot is the base directory all local file operations are jailed to.
	DownloadRoot string
	Transfers    *transfer.Manager
	Anilist      *anilist.Client
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

	// servers
	mux.Handle("GET /api/servers", authed(http.HandlerFunc(s.handleServersList)))
	mux.Handle("POST /api/servers", authed(http.HandlerFunc(s.handleServerCreate)))
	mux.Handle("PUT /api/servers/{id}", authed(http.HandlerFunc(s.handleServerUpdate)))
	mux.Handle("DELETE /api/servers/{id}", authed(http.HandlerFunc(s.handleServerDelete)))
	mux.Handle("POST /api/servers/{id}/test", authed(http.HandlerFunc(s.handleServerTest)))

	// browse
	mux.Handle("GET /api/browse/local", authed(http.HandlerFunc(s.handleBrowseLocal)))
	mux.Handle("POST /api/browse/local/mkdir", authed(http.HandlerFunc(s.handleMkdirLocal)))
	mux.Handle("GET /api/servers/{id}/browse", authed(http.HandlerFunc(s.handleBrowseRemote)))

	// downloads
	mux.Handle("GET /api/downloads", authed(http.HandlerFunc(s.handleDownloadsList)))
	mux.Handle("POST /api/downloads", authed(http.HandlerFunc(s.handleDownloadCreate)))
	mux.Handle("POST /api/downloads/{id}/pause", authed(s.downloadAction(s.Transfers.Pause)))
	mux.Handle("POST /api/downloads/{id}/resume", authed(s.downloadAction(s.Transfers.Resume)))
	mux.Handle("POST /api/downloads/{id}/cancel", authed(s.downloadAction(s.Transfers.Cancel)))
	mux.Handle("PUT /api/downloads/{id}/ratelimit", authed(http.HandlerFunc(s.handleDownloadRateLimit)))
	mux.Handle("DELETE /api/downloads/{id}", authed(http.HandlerFunc(s.handleDownloadDelete)))
	mux.Handle("GET /api/events", authed(http.HandlerFunc(s.handleEvents)))

	// settings
	mux.Handle("GET /api/settings", authed(http.HandlerFunc(s.handleSettingsGet)))
	mux.Handle("PUT /api/settings", authed(http.HandlerFunc(s.handleSettingsPut)))

	// anilist + catalog
	mux.Handle("GET /api/anilist/search", authed(http.HandlerFunc(s.handleAnilistSearch)))
	mux.Handle("GET /api/anilist/media/{id}", authed(http.HandlerFunc(s.handleAnilistMedia)))
	mux.Handle("GET /api/servers/{id}/catalog", authed(http.HandlerFunc(s.handleCatalog)))
	mux.Handle("PUT /api/servers/{id}/catalog/match", authed(http.HandlerFunc(s.handleCatalogMatch)))

	// rename
	mux.Handle("POST /api/rename/preview", authed(http.HandlerFunc(s.handleRenamePreview)))
	mux.Handle("POST /api/rename/apply", authed(http.HandlerFunc(s.handleRenameApply)))
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
