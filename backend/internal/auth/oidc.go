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
	// adminClaim/adminValue map an ID-token claim to is_admin (e.g. claim
	// "groups" containing "admin"). Empty adminClaim disables the mapping.
	adminClaim string
	adminValue string
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
	adminClaim := db.SettingOrEnv(m.DB, "oidc_admin_claim", "OIDC_ADMIN_CLAIM")
	scopes := []string{oidc.ScopeOpenID, "email", "profile"}
	if adminClaim != "" && adminClaim != "email" && adminClaim != "profile" {
		// claim usually needs its scope requested (e.g. VoidAuth "groups")
		scopes = append(scopes, adminClaim)
	}
	o := &OIDC{
		config: oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  redirectURL,
			Scopes:       scopes,
		},
		verifier:   provider.Verifier(&oidc.Config{ClientID: clientID}),
		adminClaim: adminClaim,
		adminValue: db.SettingOrEnv(m.DB, "oidc_admin_value", "OIDC_ADMIN_VALUE"),
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
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "invalid claims", http.StatusBadGateway)
		return
	}
	email, _ := claims["email"].(string)
	if email == "" {
		http.Error(w, "no email claim", http.StatusBadGateway)
		return
	}
	// admin mapping: only sync when the claim is present, so a misconfigured
	// claim name never demotes anyone
	var admin *bool
	if o.adminClaim != "" {
		if _, present := claims[o.adminClaim]; present {
			v := claimGrantsAdmin(claims, o.adminClaim, o.adminValue)
			admin = &v
		}
	}
	userID, err := findOrCreateOIDCUser(m.DB, email, admin)
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

// claimGrantsAdmin reports whether claims[name] equals or contains value.
// Handles string, bool and string-array claims (e.g. "groups": ["admin"]).
func claimGrantsAdmin(claims map[string]any, name, value string) bool {
	switch v := claims[name].(type) {
	case string:
		return v == value
	case bool:
		return v && (value == "" || value == "true")
	case []any:
		for _, e := range v {
			if s, ok := e.(string); ok && s == value {
				return true
			}
		}
	}
	return false
}

// findOrCreateOIDCUser links the user by verified email. admin (nil = no
// mapping configured / claim absent) syncs is_admin from the identity
// provider on every login; the last remaining admin is never demoted.
func findOrCreateOIDCUser(d *sql.DB, email string, admin *bool) (int64, error) {
	var id int64
	err := d.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	if err == nil {
		if admin != nil {
			if !*admin {
				var others int
				if err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE is_admin = 1 AND id != ?`, id).Scan(&others); err != nil || others == 0 {
					slog.Warn("oidc admin mapping: not demoting the last admin", "email", email)
					return id, nil
				}
			}
			d.Exec(`UPDATE users SET is_admin = ? WHERE id = ?`, *admin, id)
		}
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	if RegistrationDisabled(d) {
		return 0, fmt.Errorf("registration is disabled")
	}
	// first user always becomes admin (an install must never be adminless)
	res, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES (?, (SELECT COUNT(*) = 0 FROM users) OR ?)`,
		email, admin != nil && *admin)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func RegistrationDisabled(d *sql.DB) bool {
	return db.Setting(d, "registration_disabled") == "true"
}
