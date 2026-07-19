// Package api wires all HTTP handlers.
package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/mailer"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/transfer"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

type Server struct {
	DB   *sql.DB
	OIDC *auth.Manager
	// DownloadRoot is the primary local root (default download dir).
	DownloadRoot string
	// LocalRoots is the allowlist of local roots a target may live under
	// (arbitrary media mounts); empty falls back to [DownloadRoot].
	LocalRoots []string
	Transfers  *transfer.Manager
	Anilist    *anilist.Client
	Tmdb       *tmdb.Client
	Tvdb       *tvdb.Client // aired-order season mapping for endless series
	Push       *push.Service
	Mail       *mailer.Service
	// Conns pools and caps SSH/FTP connections per server (multiplexes SFTP
	// channels; downloads take priority over the index crawler).
	Conns *pool.Pool

	// background AniList matching (see queueMatch in anilist.go):
	// dedup of in-flight jobs plus a queue drained in batches by one worker
	matchMu   sync.Mutex
	matchJobs map[string]bool
	matchCh   chan matchJob
	matchOnce sync.Once

	// per-IP brute-force limiter on the auth endpoints; admin-inspectable
	authLimiter *ipLimiter

	// pending download-notification digests: "userID|category" → items
	digestMu sync.Mutex
	digest   map[string][]digestItem
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

	// auth - login/register are rate-limited per IP against brute-force;
	// admin-configured trusted networks bypass the limit
	if s.authLimiter == nil {
		s.authLimiter = newIPLimiter(5, 5, s.ipTrusted)
	}
	mux.HandleFunc("POST /api/auth/register", s.authLimiter.limit(s.handleRegister))
	mux.HandleFunc("POST /api/auth/login", s.authLimiter.limit(s.handleLogin))
	mux.HandleFunc("POST /api/auth/login/totp", s.authLimiter.limit(s.handleLoginTotp))
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	// per-user TOTP enrollment (any authenticated user, not admin-only)
	mux.Handle("GET /api/auth/totp", authed(http.HandlerFunc(s.handleTotpStatus)))
	mux.Handle("POST /api/auth/totp/setup", authed(http.HandlerFunc(s.handleTotpSetup)))
	mux.Handle("POST /api/auth/totp/confirm", authed(http.HandlerFunc(s.handleTotpConfirm)))
	mux.Handle("DELETE /api/auth/totp", authed(http.HandlerFunc(s.handleTotpDisable)))
	// WebAuthn: passwordless passkey login + security-key second factor
	mux.Handle("POST /api/auth/webauthn/register/begin", authed(http.HandlerFunc(s.handleWebAuthnRegisterBegin)))
	mux.Handle("POST /api/auth/webauthn/register/finish", authed(http.HandlerFunc(s.handleWebAuthnRegisterFinish)))
	mux.Handle("GET /api/auth/webauthn/credentials", authed(http.HandlerFunc(s.handleWebAuthnList)))
	mux.Handle("DELETE /api/auth/webauthn/credentials/{id}", authed(http.HandlerFunc(s.handleWebAuthnDelete)))
	mux.HandleFunc("POST /api/auth/webauthn/login/begin", s.authLimiter.limit(s.handleWebAuthnLoginBegin))
	mux.HandleFunc("POST /api/auth/webauthn/login/finish", s.authLimiter.limit(s.handleWebAuthnLoginFinish))
	mux.HandleFunc("POST /api/auth/webauthn/2fa/begin", s.authLimiter.limit(s.handleWebAuthn2FABegin))
	mux.HandleFunc("POST /api/auth/webauthn/2fa/finish", s.authLimiter.limit(s.handleWebAuthn2FAFinish))
	mux.Handle("GET /api/auth/me", authed(http.HandlerFunc(s.handleMe)))
	mux.HandleFunc("GET /api/auth/config", s.handleAuthConfig)
	mux.HandleFunc("POST /api/auth/setup/oidc", s.handleSetupOIDC)
	// optional session: guarded inside (open during first-run, admin afterwards)
	mux.Handle("POST /api/auth/oidc/discover", auth.Middleware(s.DB, false)(http.HandlerFunc(s.handleOIDCDiscover)))
	mux.HandleFunc("GET /api/auth/oidc/login", s.OIDC.LoginHandler)
	mux.HandleFunc("GET /api/auth/oidc/callback", s.OIDC.CallbackHandler)
	mux.HandleFunc("GET /api/auth/verify", s.handleVerifyEmail)
	mux.Handle("PUT /api/auth/locale", authed(http.HandlerFunc(s.handleLocalePut)))
	mux.Handle("GET /api/auth/email-prefs", authed(http.HandlerFunc(s.handleEmailPrefsGet)))
	mux.Handle("PUT /api/auth/email-prefs", authed(http.HandlerFunc(s.handleEmailPrefsPut)))

	// servers
	mux.Handle("GET /api/servers", authed(http.HandlerFunc(s.handleServersList)))
	mux.Handle("POST /api/servers", authed(http.HandlerFunc(s.handleServerCreate)))
	mux.Handle("PUT /api/servers/{id}", authed(http.HandlerFunc(s.handleServerUpdate)))
	mux.Handle("DELETE /api/servers/{id}", authed(http.HandlerFunc(s.handleServerDelete)))
	mux.Handle("POST /api/servers/{id}/test", authed(http.HandlerFunc(s.handleServerTest)))
	mux.Handle("POST /api/servers/{id}/trust-hostkey", authed(http.HandlerFunc(s.handleServerTrustHostKey)))

	// browse
	mux.Handle("GET /api/browse/local", authed(http.HandlerFunc(s.handleBrowseLocal)))
	mux.Handle("POST /api/browse/local/mkdir", authed(http.HandlerFunc(s.handleMkdirLocal)))
	mux.Handle("GET /api/servers/{id}/browse", authed(http.HandlerFunc(s.handleBrowseRemote)))
	mux.Handle("GET /api/servers/{id}/search", authed(http.HandlerFunc(s.handleServerSearch)))
	mux.Handle("GET /api/servers/{id}/languages", authed(http.HandlerFunc(s.handleServerLanguages)))

	// downloads
	mux.Handle("GET /api/downloads", authed(http.HandlerFunc(s.handleDownloadsList)))
	mux.Handle("POST /api/downloads", authed(http.HandlerFunc(s.handleDownloadCreate)))
	mux.Handle("POST /api/downloads/cancel", authed(http.HandlerFunc(s.handleDownloadsCancel)))
	mux.Handle("POST /api/downloads/bulk", authed(http.HandlerFunc(s.handleDownloadsBulk)))
	mux.Handle("PUT /api/downloads/ratelimit", authed(adminOnly(http.HandlerFunc(s.handleGlobalRateLimit))))
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
	mux.Handle("GET /api/settings", authed(adminOnly(http.HandlerFunc(s.handleSettingsGet))))
	mux.Handle("PUT /api/settings", authed(adminOnly(http.HandlerFunc(s.handleSettingsPut))))

	// build/version info + upstream update check (about page)
	mux.Handle("GET /api/version", authed(http.HandlerFunc(s.handleVersion)))
	mux.Handle("POST /api/version/update-check", authed(adminOnly(http.HandlerFunc(s.handleUpdateCheckToggle))))

	// interactive OpenAPI docs - dev builds only (never nightly/stable)
	if devDocsEnabled() {
		mux.Handle("GET /api/openapi.json", authed(http.HandlerFunc(s.handleOpenAPISpec)))
		mux.Handle("GET /api/docs/", authed(swaggerUIHandler()))
	}

	// machine API token (Home Assistant etc.); raw token is shown once
	mux.Handle("POST /api/settings/token", authed(adminOnly(http.HandlerFunc(s.handleTokenCreate))))
	mux.Handle("DELETE /api/settings/token", authed(adminOnly(http.HandlerFunc(s.handleTokenDelete))))

	// aggregate status: admin session or machine token
	statusH := http.HandlerFunc(s.handleStatus)
	mux.Handle("GET /api/status", s.bearerOr(authed(adminOnly(statusH)), statusH))

	// rate-limit admin: inspect and unblock throttled IPs
	mux.Handle("GET /api/auth/ratelimit", authed(adminOnly(http.HandlerFunc(s.handleRateLimitList))))
	mux.Handle("POST /api/auth/ratelimit/reset", authed(adminOnly(http.HandlerFunc(s.handleRateLimitReset))))

	// web push
	mux.Handle("GET /api/push/key", authed(http.HandlerFunc(s.handlePushKey)))
	mux.Handle("POST /api/push/subscribe", authed(http.HandlerFunc(s.handlePushSubscribe)))
	mux.Handle("DELETE /api/push/subscribe", authed(http.HandlerFunc(s.handlePushUnsubscribe)))

	// watches (persistent auto-sync)
	mux.Handle("GET /api/watches", authed(http.HandlerFunc(s.handleWatchesList)))
	mux.Handle("POST /api/watches", authed(http.HandlerFunc(s.handleWatchCreate)))
	mux.Handle("PUT /api/watches/{id}", authed(http.HandlerFunc(s.handleWatchUpdate)))
	mux.Handle("DELETE /api/watches/{id}", authed(http.HandlerFunc(s.handleWatchDelete)))
	checkH := http.HandlerFunc(s.handleWatchCheck)
	mux.Handle("POST /api/watches/{id}/check", s.bearerOr(authed(checkH), checkH))

	// anilist + catalog
	mux.Handle("GET /api/anilist/search", authed(http.HandlerFunc(s.handleAnilistSearch)))
	mux.Handle("GET /api/anilist/media/{id}", authed(http.HandlerFunc(s.handleAnilistMedia)))
	mux.Handle("GET /api/media/reviews", authed(http.HandlerFunc(s.handleMediaReviews)))
	mux.Handle("GET /api/plex/sections", authed(http.HandlerFunc(s.handlePlexSections)))
	mux.Handle("GET /api/plex/suggestions", authed(http.HandlerFunc(s.handlePlexSuggestions)))

	mux.Handle("GET /api/servers/{id}/rename-profile", authed(http.HandlerFunc(s.handleRenameProfile)))
	mux.Handle("GET /api/servers/{id}/catalog", authed(http.HandlerFunc(s.handleCatalog)))
	mux.Handle("PUT /api/servers/{id}/catalog/match", authed(http.HandlerFunc(s.handleCatalogMatch)))
	mux.Handle("POST /api/servers/{id}/catalog/rematch", authed(http.HandlerFunc(s.handleCatalogRematch)))
	mux.Handle("GET /api/servers/{id}/catalog/scope", authed(http.HandlerFunc(s.handleCatalogScopeGet)))
	mux.Handle("PUT /api/servers/{id}/catalog/scope", authed(http.HandlerFunc(s.handleCatalogScope)))
	mux.Handle("GET /api/anilist/connect", authed(http.HandlerFunc(s.handleAnilistConnect)))
	mux.Handle("POST /api/anilist/token", authed(http.HandlerFunc(s.handleAnilistToken)))
	mux.Handle("GET /api/anilist/callback", authed(http.HandlerFunc(s.handleAnilistCallback)))
	mux.Handle("DELETE /api/anilist/connect", authed(http.HandlerFunc(s.handleAnilistDisconnect)))
	mux.Handle("GET /api/anilist/me", authed(http.HandlerFunc(s.handleAnilistMe)))
	mux.Handle("POST /api/anilist/progress", authed(http.HandlerFunc(s.handleAnilistProgress)))
	mux.Handle("GET /api/anilist/suggestions", authed(http.HandlerFunc(s.handleAnilistSuggestions)))
	mux.Handle("GET /api/tmdb/search", authed(http.HandlerFunc(s.handleTmdbSearch)))
	mux.Handle("GET /api/tmdb/media", authed(http.HandlerFunc(s.handleTmdbMedia)))
	mux.Handle("GET /api/tvdb/search", authed(http.HandlerFunc(s.handleTvdbSearch)))
	mux.Handle("GET /api/tvdb/media", authed(http.HandlerFunc(s.handleTvdbMedia)))
	mux.Handle("GET /api/tmdb/connect", authed(http.HandlerFunc(s.handleTmdbConnect)))
	mux.Handle("GET /api/tmdb/callback", authed(http.HandlerFunc(s.handleTmdbCallback)))
	mux.Handle("DELETE /api/tmdb/connect", authed(http.HandlerFunc(s.handleTmdbDisconnect)))
	mux.Handle("GET /api/tmdb/me", authed(http.HandlerFunc(s.handleTmdbMe)))
	mux.Handle("GET /api/tmdb/suggestions", authed(http.HandlerFunc(s.handleTmdbSuggestions)))

	// rename
	mux.Handle("POST /api/rename/preview", authed(http.HandlerFunc(s.handleRenamePreview)))
	mux.Handle("POST /api/rename/apply", authed(http.HandlerFunc(s.handleRenameApply)))
	mux.Handle("POST /api/rename/names", authed(http.HandlerFunc(s.handleRenameNames)))

	// admin: background jobs and cache maintenance
	mux.Handle("GET /api/admin/jobs", authed(adminOnly(http.HandlerFunc(s.handleAdminJobs))))
	mux.Handle("POST /api/admin/jobs/{name}/run", authed(adminOnly(http.HandlerFunc(s.handleAdminJobRun))))
	mux.Handle("DELETE /api/admin/cache/{scope}", authed(adminOnly(http.HandlerFunc(s.handleAdminCacheFlush))))
	mux.Handle("DELETE /api/admin/index/{id}", authed(adminOnly(http.HandlerFunc(s.handleAdminIndexFlush))))
	mux.Handle("GET /api/admin/cache/{scope}/entries", authed(adminOnly(http.HandlerFunc(s.handleAdminCacheEntries))))
	mux.Handle("DELETE /api/admin/cache/{scope}/entries", authed(adminOnly(http.HandlerFunc(s.handleAdminCacheEntryDelete))))
	mux.Handle("GET /api/admin/matches", authed(adminOnly(http.HandlerFunc(s.handleAdminMatches))))
	mux.Handle("DELETE /api/admin/matches", authed(adminOnly(http.HandlerFunc(s.handleAdminMatchDelete))))
	mux.Handle("PUT /api/admin/ttl", authed(adminOnly(http.HandlerFunc(s.handleAdminTTL))))
	mux.Handle("PUT /api/admin/index/{id}/config", authed(adminOnly(http.HandlerFunc(s.handleAdminIndexConfig))))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON", "err", err)
	}
}

// ErrorResponse is the uniform error body written by writeErr.
type ErrorResponse struct {
	Error string `json:"error"`
}

// OkResponse is the uniform {"status":"ok"} acknowledgement.
type OkResponse struct {
	Status string `json:"status" example:"ok"`
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, ErrorResponse{Error: msg})
}

// dbErr writes the uniform response for internal database failures.
func dbErr(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, "db error")
}

// pathID parses the {id} path segment. Invalid input yields 0, which no
// row ever matches, so handlers fall through to their "not found" path.
func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	// require a JSON content-type: HTML forms can only send text/plain or
	// form-urlencoded, so this blocks simple-form CSRF on state-changing routes
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		writeErr(w, http.StatusUnsupportedMediaType, "content-type must be application/json")
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}
