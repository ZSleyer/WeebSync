// Package api wires all HTTP handlers.
package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/transfer"
)

type Server struct {
	DB   *sql.DB
	OIDC *auth.Manager
	// DownloadRoot is the base directory all local file operations are jailed to.
	DownloadRoot string
	Transfers    *transfer.Manager
	Anilist      *anilist.Client
	Tmdb         *tmdb.Client
	Push         *push.Service

	// background AniList matching (see queueMatch in anilist.go):
	// dedup of in-flight jobs plus a queue drained in batches by one worker
	matchMu   sync.Mutex
	matchJobs map[string]bool
	matchCh   chan matchJob
	matchOnce sync.Once
}

// adminOnly guards admin-only endpoints (settings mutations, user management).
func adminOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := auth.UserFrom(r.Context()); u == nil || !u.IsAdmin {
			writeErr(w, http.StatusForbidden, "admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Register(mux *http.ServeMux) {
	authed := auth.Middleware(s.DB, true)

	// auth
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.Handle("GET /api/auth/me", authed(http.HandlerFunc(s.handleMe)))
	mux.HandleFunc("GET /api/auth/config", s.handleAuthConfig)
	mux.HandleFunc("POST /api/auth/setup/oidc", s.handleSetupOIDC)
	// optional session: guarded inside (open during first-run, admin afterwards)
	mux.Handle("POST /api/auth/oidc/discover", auth.Middleware(s.DB, false)(http.HandlerFunc(s.handleOIDCDiscover)))
	mux.HandleFunc("GET /api/auth/oidc/login", s.OIDC.LoginHandler)
	mux.HandleFunc("GET /api/auth/oidc/callback", s.OIDC.CallbackHandler)

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
	mux.Handle("GET /api/servers/{id}/search", authed(http.HandlerFunc(s.handleServerSearch)))

	// downloads
	mux.Handle("GET /api/downloads", authed(http.HandlerFunc(s.handleDownloadsList)))
	mux.Handle("POST /api/downloads", authed(http.HandlerFunc(s.handleDownloadCreate)))
	mux.Handle("POST /api/downloads/{id}/pause", authed(s.downloadAction(s.Transfers.Pause)))
	mux.Handle("POST /api/downloads/{id}/resume", authed(s.downloadAction(s.Transfers.Resume)))
	mux.Handle("POST /api/downloads/{id}/cancel", authed(s.downloadAction(s.Transfers.Cancel)))
	mux.Handle("PUT /api/downloads/{id}/ratelimit", authed(http.HandlerFunc(s.handleDownloadRateLimit)))
	mux.Handle("DELETE /api/downloads/{id}", authed(http.HandlerFunc(s.handleDownloadDelete)))
	mux.Handle("GET /api/events", authed(http.HandlerFunc(s.handleEvents)))

	// user management (admin-only)
	mux.Handle("GET /api/users", authed(adminOnly(http.HandlerFunc(s.handleUsersList))))
	mux.Handle("POST /api/users", authed(adminOnly(http.HandlerFunc(s.handleUserCreate))))
	mux.Handle("PUT /api/users/{id}", authed(adminOnly(http.HandlerFunc(s.handleUserUpdate))))
	mux.Handle("DELETE /api/users/{id}", authed(adminOnly(http.HandlerFunc(s.handleUserDelete))))

	// settings (mutations are admin-only)
	mux.Handle("GET /api/settings", authed(http.HandlerFunc(s.handleSettingsGet)))
	mux.Handle("PUT /api/settings", authed(adminOnly(http.HandlerFunc(s.handleSettingsPut))))

	// web push
	mux.Handle("GET /api/push/key", authed(http.HandlerFunc(s.handlePushKey)))
	mux.Handle("POST /api/push/subscribe", authed(http.HandlerFunc(s.handlePushSubscribe)))
	mux.Handle("DELETE /api/push/subscribe", authed(http.HandlerFunc(s.handlePushUnsubscribe)))

	// watches (persistent auto-sync)
	mux.Handle("GET /api/watches", authed(http.HandlerFunc(s.handleWatchesList)))
	mux.Handle("POST /api/watches", authed(http.HandlerFunc(s.handleWatchCreate)))
	mux.Handle("PUT /api/watches/{id}", authed(http.HandlerFunc(s.handleWatchUpdate)))
	mux.Handle("DELETE /api/watches/{id}", authed(http.HandlerFunc(s.handleWatchDelete)))
	mux.Handle("POST /api/watches/{id}/check", authed(http.HandlerFunc(s.handleWatchCheck)))

	// anilist + catalog
	mux.Handle("GET /api/anilist/search", authed(http.HandlerFunc(s.handleAnilistSearch)))
	mux.Handle("GET /api/anilist/media/{id}", authed(http.HandlerFunc(s.handleAnilistMedia)))
	mux.Handle("GET /api/plex/sections", authed(http.HandlerFunc(s.handlePlexSections)))
	mux.Handle("GET /api/plex/suggestions", authed(http.HandlerFunc(s.handlePlexSuggestions)))

	mux.Handle("GET /api/servers/{id}/catalog", authed(http.HandlerFunc(s.handleCatalog)))
	mux.Handle("PUT /api/servers/{id}/catalog/match", authed(http.HandlerFunc(s.handleCatalogMatch)))
	mux.Handle("POST /api/servers/{id}/catalog/rematch", authed(http.HandlerFunc(s.handleCatalogRematch)))
	mux.Handle("PUT /api/servers/{id}/catalog/scope", authed(http.HandlerFunc(s.handleCatalogScope)))
	mux.Handle("GET /api/anilist/connect", authed(http.HandlerFunc(s.handleAnilistConnect)))
	mux.Handle("GET /api/anilist/callback", authed(http.HandlerFunc(s.handleAnilistCallback)))
	mux.Handle("DELETE /api/anilist/connect", authed(http.HandlerFunc(s.handleAnilistDisconnect)))
	mux.Handle("GET /api/anilist/me", authed(http.HandlerFunc(s.handleAnilistMe)))
	mux.Handle("POST /api/anilist/progress", authed(http.HandlerFunc(s.handleAnilistProgress)))
	mux.Handle("GET /api/anilist/suggestions", authed(http.HandlerFunc(s.handleAnilistSuggestions)))
	mux.Handle("GET /api/tmdb/search", authed(http.HandlerFunc(s.handleTmdbSearch)))
	mux.Handle("GET /api/tmdb/media", authed(http.HandlerFunc(s.handleTmdbMedia)))

	// rename
	mux.Handle("POST /api/rename/preview", authed(http.HandlerFunc(s.handleRenamePreview)))
	mux.Handle("POST /api/rename/apply", authed(http.HandlerFunc(s.handleRenameApply)))
	mux.Handle("POST /api/rename/names", authed(http.HandlerFunc(s.handleRenameNames)))
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
