package api

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
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

// handleSetupOIDC lets the first-run wizard store an OIDC config before any
// account exists, so a pure-OIDC instance never needs a password account (the
// first OIDC login becomes admin). Only reachable while there are zero users;
// afterwards OIDC config requires an admin session via the settings API.
func (s *Server) handleSetupOIDC(w http.ResponseWriter, r *http.Request) {
	var users int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users)
	if users > 0 {
		writeErr(w, http.StatusForbidden, "setup already completed")
		return
	}
	var in struct {
		OidcProviderName string `json:"oidcProviderName"`
		OidcIssuer       string `json:"oidcIssuer"`
		OidcClientID     string `json:"oidcClientId"`
		OidcClientSecret string `json:"oidcClientSecret"`
		OidcRedirectURL  string `json:"oidcRedirectUrl"`
		OidcClaim        string `json:"oidcClaim"`
		OidcAdminValues  string `json:"oidcAdminValues"`
		OidcUserValues   string `json:"oidcUserValues"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.OidcIssuer == "" {
		writeErr(w, http.StatusBadRequest, "issuer required")
		return
	}
	db.SetSetting(s.DB, "oidc_provider_name", in.OidcProviderName)
	db.SetSetting(s.DB, "oidc_issuer", in.OidcIssuer)
	db.SetSetting(s.DB, "oidc_client_id", in.OidcClientID)
	db.SetSetting(s.DB, "oidc_client_secret", in.OidcClientSecret)
	db.SetSetting(s.DB, "oidc_redirect_url", in.OidcRedirectURL)
	db.SetSetting(s.DB, "oidc_claim", in.OidcClaim)
	db.SetSetting(s.DB, "oidc_admin_values", in.OidcAdminValues)
	db.SetSetting(s.DB, "oidc_user_values", in.OidcUserValues)
	out := map[string]any{}
	if err := s.OIDC.Reload(r.Context()); err != nil {
		out["oidcError"] = err.Error()
	}
	out["oidcEnabled"] = s.OIDC.Enabled()
	writeJSON(w, http.StatusOK, out)
}

// handleOIDCDiscover probes a base URL for an OIDC provider so the user only
// enters the domain: the URL itself plus common mount paths are tried for a
// discovery document, the issuer from the first hit wins. Server-side fetch of
// a user-supplied URL — no new exposure, a configured issuer is fetched on
// Reload anyway — but gated like setup: open only while there are zero users,
// admin session afterwards.
func (s *Server) handleOIDCDiscover(w http.ResponseWriter, r *http.Request) {
	var users int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users)
	if u := auth.UserFrom(r.Context()); users > 0 && (u == nil || !u.IsAdmin) {
		writeErr(w, http.StatusForbidden, "admin only")
		return
	}
	var in struct {
		URL string `json:"url"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	base := strings.TrimSpace(in.URL)
	if base == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	base = strings.TrimSuffix(base, "/.well-known/openid-configuration")
	base = strings.TrimRight(base, "/")

	client := &http.Client{Timeout: 5 * time.Second}
	for _, cand := range []string{base, base + "/oidc"} {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, cand+"/.well-known/openid-configuration", nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		var doc struct {
			Issuer string `json:"issuer"`
		}
		derr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK && derr == nil && doc.Issuer != "" {
			writeJSON(w, http.StatusOK, map[string]string{"issuer": doc.Issuer})
			return
		}
	}
	writeErr(w, http.StatusNotFound, "no oidc provider found at this url")
}

// handleAuthConfig tells the login page whether OIDC is available, whether
// registration is open, which auth mode is active (password | oidc-only |
// oidc-auto) and whether first-run setup is still pending (no users yet).
func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	mode := auth.AuthMode(s.DB)
	if !s.OIDC.Enabled() {
		mode = "password" // never lock the UI on a broken OIDC config
	}
	var users int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users)
	writeJSON(w, http.StatusOK, map[string]any{
		"oidc":             s.OIDC.Enabled(),
		"oidcName":         db.SettingOrEnv(s.DB, "oidc_provider_name", "OIDC_PROVIDER_NAME"),
		"registrationOpen": !auth.RegistrationDisabled(s.DB),
		"authMode":         mode,
		"setupNeeded":      users == 0,
	})
}
