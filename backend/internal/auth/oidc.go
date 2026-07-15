package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDC struct {
	config   oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// Manager holds the current OIDC provider; settings changes rebuild it at
// runtime (no restart). Settings come from the DB with env fallback.
type Manager struct {
	DB  *sql.DB
	mu  sync.RWMutex
	cur *OIDC
}

func NewManager(ctx context.Context, d *sql.DB) *Manager {
	m := &Manager{DB: d}
	if err := m.Reload(ctx); err != nil {
		// misconfigured OIDC must not take the whole app down; login page
		// simply won't offer it and the settings UI shows the error
		slog.Warn("oidc init", "err", err)
	}
	return m
}

func (m *Manager) Get() *OIDC {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cur
}

func (m *Manager) Enabled() bool { return m.Get() != nil }

// Reload rebuilds the provider from current settings. Empty issuer disables OIDC.
func (m *Manager) Reload(ctx context.Context) error {
	issuer := db.SettingOrEnv(m.DB, "oidc_issuer", "OIDC_ISSUER")
	if issuer == "" {
		m.mu.Lock()
		m.cur = nil
		m.mu.Unlock()
		return nil
	}
	clientID := db.SettingOrEnv(m.DB, "oidc_client_id", "OIDC_CLIENT_ID")
	clientSecret := db.SettingOrEnv(m.DB, "oidc_client_secret", "OIDC_CLIENT_SECRET")
	redirectURL := db.SettingOrEnv(m.DB, "oidc_redirect_url", "OIDC_REDIRECT_URL")
	if clientID == "" || redirectURL == "" {
		return fmt.Errorf("oidc: issuer set but client id or redirect url missing")
	}
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	o := &OIDC{
		config: oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  redirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: clientID}),
	}
	m.mu.Lock()
	m.cur = o
	m.mu.Unlock()
	return nil
}

// AuthMode: "password" (default, password + optional OIDC button),
// "oidc-only" (no password form), "oidc-auto" (login page redirects).
func AuthMode(d *sql.DB) string {
	switch v := db.Setting(d, "auth_mode"); v {
	case "oidc-only", "oidc-auto":
		return v
	default:
		return "password"
	}
}

// LoginHandler redirects to the identity provider with a random state cookie.
func (m *Manager) LoginHandler(w http.ResponseWriter, r *http.Request) {
	o := m.Get()
	if o == nil {
		http.Error(w, "oidc not configured", http.StatusNotFound)
		return
	}
	raw := make([]byte, 16)
	rand.Read(raw)
	state := hex.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_oidc_state", Value: state, Path: "/api/auth/oidc",
		MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	http.Redirect(w, r, o.config.AuthCodeURL(state), http.StatusFound)
}

// CallbackHandler exchanges the code, verifies the ID token, links or creates
// the user by verified email and starts a session.
func (m *Manager) CallbackHandler(w http.ResponseWriter, r *http.Request) {
	o := m.Get()
	if o == nil {
		http.Error(w, "oidc not configured", http.StatusNotFound)
		return
	}
	stateCookie, err := r.Cookie("weebsync_oidc_state")
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	token, err := o.config.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, _ := token.Extra("id_token").(string)
	idToken, err := o.verifier.Verify(r.Context(), rawID)
	if err != nil {
		http.Error(w, "id token verification failed", http.StatusBadGateway)
		return
	}
	var claims struct {
		Email string `json:"email"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Email == "" {
		http.Error(w, "no email claim", http.StatusBadGateway)
		return
	}
	userID, err := findOrCreateOIDCUser(m.DB, claims.Email)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	if err := CreateSession(m.DB, w, r, userID); err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

func findOrCreateOIDCUser(d *sql.DB, email string) (int64, error) {
	var id int64
	err := d.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	if RegistrationDisabled(d) {
		return 0, fmt.Errorf("registration is disabled")
	}
	res, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES (?, (SELECT COUNT(*) = 0 FROM users))`, email)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func RegistrationDisabled(d *sql.DB) bool {
	return db.Setting(d, "registration_disabled") == "true"
}
