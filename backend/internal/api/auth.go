package api

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
)

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// ui language at registration time, so the verify email is localized
	// before the first locale sync can happen
	Locale string `json:"locale,omitempty"`
}

func validLocale(l string) string {
	if l == "de" || l == "en" {
		return l
	}
	return ""
}

// passwordAuthBlocked: in oidc-only/auto mode the password endpoints are
// disabled - but only while OIDC actually works, so a broken provider can
// never lock everyone out. Existing local users migrate automatically: the
// OIDC callback links accounts by email address.
func (s *Server) passwordAuthBlocked() bool {
	return auth.AuthMode(s.DB) != "password" && s.OIDC.Enabled()
}

// RegisterResponse is returned by handleRegister: either the created account
// (id + email) or a pending email verification (needsVerification + email).
type RegisterResponse struct {
	ID                int64  `json:"id,omitempty"`
	Email             string `json:"email"`
	NeedsVerification bool   `json:"needsVerification,omitempty"`
}

// handleRegister creates a local account. The first-ever account becomes the
// admin; afterwards registration must be enabled.
// @Summary  Register a local account
// @Description Creates an email/password account. The first account becomes admin. When SMTP is configured, later accounts must verify their email before login. Disabled while OIDC-only auth is active.
// @Tags     Auth
// @Accept   json
// @Produce  json
// @Param    body body credentials true "Credentials"
// @Success  200 {object} RegisterResponse "verification email sent"
// @Success  201 {object} RegisterResponse "account created, session established"
// @Failure  400 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/register [post]
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
	// The very first account (first-run admin) may always register, so a
	// closed-by-default registration never locks a fresh instance out;
	// afterwards open registration must be explicitly enabled.
	var existing int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&existing)
	if existing > 0 && auth.RegistrationDisabled(s.DB) {
		writeErr(w, http.StatusForbidden, "registration is disabled")
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash error")
		return
	}
	// Email verification is required for local accounts only when SMTP is set
	// up, and never for the very first account (the admin during first-run,
	// before SMTP can exist) - requiring it there would lock the instance out.
	needVerify := existing > 0 && s.Mail != nil && s.Mail.Configured()

	verified, token := 1, ""
	if needVerify {
		verified, token = 0, randToken()
	}
	// first user becomes admin
	res, err := s.DB.Exec(`INSERT INTO users (email, password_hash, is_admin, email_verified, verify_token, locale)
		VALUES (?, ?, (SELECT COUNT(*) = 0 FROM users), ?, ?, ?)`, c.Email, hash, verified, token, validLocale(c.Locale))
	if err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	id, _ := res.LastInsertId()

	// notify admins who subscribed (skip the very first account - it IS the admin)
	if existing > 0 {
		s.EmailNotifyAdmins("admin_new_user", "email.newUserSubject", "email.newUserBody", c.Email)
	}

	if needVerify {
		go s.sendVerifyEmail(c.Email, token, requestOrigin(r), s.userLocale(id))
		writeJSON(w, http.StatusOK, RegisterResponse{NeedsVerification: true, Email: c.Email})
		return
	}
	if err := auth.CreateSession(s.DB, w, r, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusCreated, RegisterResponse{ID: id, Email: c.Email})
}

// LocaleResponse echoes the stored UI locale.
type LocaleResponse struct {
	Locale string `json:"locale"`
}

// handleLocalePut stores the caller's ui language so server-delivered texts
// (email, web push) match it. The frontend syncs it fire-and-forget.
// @Summary  Set UI locale
// @Description Stores the caller's UI language (de or en) for server-delivered emails and push notifications.
// @Tags     Auth
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"locale\":\"de|en\"}"
// @Success  200 {object} LocaleResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/locale [put]
func (s *Server) handleLocalePut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Locale string `json:"locale"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	l := validLocale(in.Locale)
	if l == "" {
		writeErr(w, http.StatusBadRequest, "locale must be de or en")
		return
	}
	if _, err := s.DB.Exec(`UPDATE users SET locale = ? WHERE id = ?`, l, u.ID); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, LocaleResponse{Locale: l})
}

// LoginResponse is returned on a successful login (id + email) or, when a
// second factor is enrolled, as a twoFactorRequired challenge carrying a
// short-lived token and the enabled methods.
type LoginResponse struct {
	ID                int64  `json:"id,omitempty"`
	Email             string `json:"email,omitempty"`
	TwoFactorRequired bool   `json:"twoFactorRequired,omitempty"`
	Token             string `json:"token,omitempty"`
	Totp              bool   `json:"totp,omitempty"`
	Webauthn          bool   `json:"webauthn,omitempty"`
}

// handleLogin authenticates email + password.
// @Summary  Log in with email and password
// @Description Returns a session cookie on success, or a twoFactorRequired challenge (with a short-lived token) when TOTP or a security key is enrolled. Disabled while OIDC-only auth is active.
// @Tags     Auth
// @Accept   json
// @Produce  json
// @Param    body body credentials true "Credentials"
// @Success  200 {object} LoginResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/login [post]
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
	var verified int
	err := s.DB.QueryRow(`SELECT id, password_hash, email_verified FROM users WHERE email = ?`, c.Email).Scan(&id, &hash, &verified)
	if err != nil && err != sql.ErrNoRows {
		dbErr(w)
		return
	}
	if err == sql.ErrNoRows || hash == "" {
		auth.DummyVerify(c.Password) // equalize timing so unknown emails aren't distinguishable
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if !auth.VerifyPassword(c.Password, hash) {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if verified == 0 {
		writeErr(w, http.StatusForbidden, "email not verified - check your inbox")
		return
	}
	// second factor: if TOTP or a security key is enrolled, hand back a
	// short-lived pending token instead of a session; the client completes at
	// /api/auth/login/totp or /api/auth/webauthn/2fa/*.
	totpOn, keyOn := s.totpEnabled(id), s.hasSecurityKey(id)
	if totpOn || keyOn {
		token, err := s.newLoginPending(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "login error")
			return
		}
		writeJSON(w, http.StatusOK, LoginResponse{TwoFactorRequired: true, Token: token, Totp: totpOn, Webauthn: keyOn})
		return
	}
	if err := auth.CreateSession(s.DB, w, r, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusOK, LoginResponse{ID: id, Email: c.Email})
}

// handleLogout ends the current session.
// @Summary  Log out
// @Description Destroys the current session and clears the session cookie.
// @Tags     Auth
// @Produce  json
// @Success  200 {object} OkResponse
// @Router   /api/auth/logout [post]
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	auth.DestroySession(s.DB, w, r)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// MeResponse describes the authenticated user (mirrors auth.User).
type MeResponse struct {
	ID      int64  `json:"id"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"isAdmin"`
}

// handleMe returns the current user.
// @Summary  Current user
// @Description Returns the authenticated user's id, email and admin flag.
// @Tags     Auth
// @Produce  json
// @Success  200 {object} MeResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/me [get]
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, auth.UserFrom(r.Context()))
}

// SetupOIDCResponse reports the result of applying a first-run OIDC config.
type SetupOIDCResponse struct {
	OidcError   string `json:"oidcError,omitempty"`
	OidcEnabled bool   `json:"oidcEnabled"`
}

// handleSetupOIDC lets the first-run wizard store an OIDC config before any
// account exists, so a pure-OIDC instance never needs a password account (the
// first OIDC login becomes admin). Only reachable while there are zero users;
// afterwards OIDC config requires an admin session via the settings API.
// @Summary  First-run OIDC setup
// @Description Stores an OIDC provider configuration during first-run setup, before any account exists. Only reachable while there are zero users; afterwards OIDC config requires an admin session.
// @Tags     Auth
// @Accept   json
// @Produce  json
// @Param    body body object true "OIDC provider configuration"
// @Success  200 {object} SetupOIDCResponse
// @Failure  400 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/setup/oidc [post]
func (s *Server) handleSetupOIDC(w http.ResponseWriter, r *http.Request) {
	var users int
	// fail closed: a db error must not reopen the unauthenticated setup path
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		dbErr(w)
		return
	}
	if users > 0 {
		writeErr(w, http.StatusForbidden, "setup already completed")
		return
	}
	var in struct {
		BaseURL          string `json:"baseUrl"`
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
	// an env-provided issuer arrives empty from the wizard's locked field
	if in.OidcIssuer == "" && !envLocked("oidc_issuer") {
		writeErr(w, http.StatusBadRequest, "issuer required")
		return
	}
	if b := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/"); b != "" {
		setSetting(s.DB, "base_url", b)
	}
	// setSetting skips env-locked keys: env-provided OIDC config wins
	setSetting(s.DB, "oidc_provider_name", in.OidcProviderName)
	setSetting(s.DB, "oidc_issuer", in.OidcIssuer)
	setSetting(s.DB, "oidc_client_id", in.OidcClientID)
	setSetting(s.DB, "oidc_client_secret", in.OidcClientSecret)
	setSetting(s.DB, "oidc_redirect_url", in.OidcRedirectURL)
	setSetting(s.DB, "oidc_claim", in.OidcClaim)
	setSetting(s.DB, "oidc_admin_values", in.OidcAdminValues)
	setSetting(s.DB, "oidc_user_values", in.OidcUserValues)
	out := SetupOIDCResponse{}
	if err := s.OIDC.Reload(r.Context()); err != nil {
		out.OidcError = err.Error()
	}
	out.OidcEnabled = s.OIDC.Enabled()
	writeJSON(w, http.StatusOK, out)
}

// handleOIDCDiscover probes a base URL for an OIDC provider so the user only
// enters the domain: the URL itself plus common mount paths are tried for a
// discovery document, the issuer from the first hit wins. Server-side fetch of
// a user-supplied URL - no new exposure, a configured issuer is fetched on
// Reload anyway - but gated like setup: open only while there are zero users,
// admin session afterwards.
// OIDCDiscoverResponse carries the discovered issuer URL.
type OIDCDiscoverResponse struct {
	Issuer string `json:"issuer"`
}

// @Summary  Probe a URL for an OIDC provider
// @Description Probes a base URL (and common mount paths) for an OIDC discovery document and returns the issuer of the first hit. Open during first-run; requires an admin session afterwards.
// @Tags     Auth
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"url\":\"https://idp.example.com\"}"
// @Success  200 {object} OIDCDiscoverResponse
// @Failure  400 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/oidc/discover [post]
func (s *Server) handleOIDCDiscover(w http.ResponseWriter, r *http.Request) {
	var users int
	// fail closed: a db error must not reopen the unauthenticated probe
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		dbErr(w)
		return
	}
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

	if u, uerr := url.Parse(base); uerr != nil || u.Hostname() == "" {
		writeErr(w, http.StatusBadRequest, "invalid url")
		return
	} else if err := netguard.Allowed(u.Hostname()); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// guarded client: the lexical Allowed() above is not enough - a 302 to
	// 169.254.169.254 or a DNS rebind would otherwise reach the metadata service
	client := netguard.Client(5 * time.Second)
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
			writeJSON(w, http.StatusOK, OIDCDiscoverResponse{Issuer: doc.Issuer})
			return
		}
	}
	writeErr(w, http.StatusNotFound, "no oidc provider found at this url")
}

// AuthConfigResponse describes the login page's auth configuration.
type AuthConfigResponse struct {
	Oidc             bool     `json:"oidc"`
	OidcName         string   `json:"oidcName"`
	RegistrationOpen bool     `json:"registrationOpen"`
	AuthMode         string   `json:"authMode"`
	SetupNeeded      bool     `json:"setupNeeded"`
	OidcEnvLocked    []string `json:"oidcEnvLocked"`
}

// handleAuthConfig tells the login page whether OIDC is available, whether
// registration is open, which auth mode is active (password | oidc-only |
// oidc-auto) and whether first-run setup is still pending (no users yet).
// @Summary  Auth configuration
// @Description Reports whether OIDC is available, whether registration is open, the active auth mode and whether first-run setup is still pending. Consumed by the login page.
// @Tags     Auth
// @Produce  json
// @Success  200 {object} AuthConfigResponse
// @Router   /api/auth/config [get]
func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	mode := auth.AuthMode(s.DB)
	if !s.OIDC.Enabled() {
		mode = "password" // never lock the UI on a broken OIDC config
	}
	var users int
	s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users)
	// oidcEnvLocked: which OIDC fields the setup wizard must lock (this
	// endpoint is unauthenticated, the wizard has no /api/settings yet)
	oidcLocked := []string{}
	for _, f := range envLockedFields() {
		if strings.HasPrefix(f, "oidc") || f == "baseUrl" {
			oidcLocked = append(oidcLocked, f)
		}
	}
	writeJSON(w, http.StatusOK, AuthConfigResponse{
		Oidc:             s.OIDC.Enabled(),
		OidcName:         db.SettingOrEnv(s.DB, "oidc_provider_name", "OIDC_PROVIDER_NAME"),
		RegistrationOpen: !auth.RegistrationDisabled(s.DB),
		AuthMode:         mode,
		SetupNeeded:      users == 0,
		OidcEnvLocked:    oidcLocked,
	})
}
