package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDC struct {
	config   oauth2.Config
	verifier *oidc.IDTokenVerifier
	// claim names the ID-token claim holding roles/groups (usually "groups").
	// adminValues: any match makes the user admin. userValues: if non-empty,
	// only members of these (or the admin) groups may log in at all.
	// Empty claim or both lists empty disables the mapping.
	claim       string
	adminValues []string
	userValues  []string
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
	if u, uerr := url.Parse(issuer); uerr != nil || u.Hostname() == "" {
		return fmt.Errorf("oidc: invalid issuer url")
	} else if err := netguard.Allowed(u.Hostname()); err != nil {
		return fmt.Errorf("oidc issuer: %w", err)
	}
	// discovery (and the JWKS/token fetches below) must go through the guarded
	// client: it re-checks every redirect hop and dials the verified IP, so a
	// discovery doc that 302s to a metadata endpoint or a rebinding host is
	// refused. Reachable unauthenticated during first-run setup.
	ctx = oidc.ClientContext(ctx, netguard.Client(10*time.Second))
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	claim := db.SettingOrEnv(m.DB, "oidc_claim", "OIDC_CLAIM")
	scopes := []string{oidc.ScopeOpenID, "email", "profile"}
	if claim != "" && claim != "email" && claim != "profile" {
		// claim usually needs its scope requested (e.g. VoidAuth "groups")
		scopes = append(scopes, claim)
	}
	o := &OIDC{
		config: oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  redirectURL,
			Scopes:       scopes,
		},
		verifier:    provider.Verifier(&oidc.Config{ClientID: clientID}),
		claim:       claim,
		adminValues: splitCSV(db.SettingOrEnv(m.DB, "oidc_admin_values", "OIDC_ADMIN_VALUES")),
		userValues:  splitCSV(db.SettingOrEnv(m.DB, "oidc_user_values", "OIDC_USER_VALUES")),
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
	state, err := randHex()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	nonce, err := randHex()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_oidc_state", Value: state, Path: "/api/auth/oidc",
		MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_oidc_nonce", Value: nonce, Path: "/api/auth/oidc",
		MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	http.Redirect(w, r, o.config.AuthCodeURL(state, oidc.Nonce(nonce)), http.StatusFound)
}

func randHex() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
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
	nonceCookie, nerr := r.Cookie("weebsync_oidc_nonce")
	// state + nonce are single-use: invalidate both so the callback URL
	// cannot be replayed within the cookies' lifetime
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_oidc_state", Value: "", Path: "/api/auth/oidc",
		MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_oidc_nonce", Value: "", Path: "/api/auth/oidc",
		MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	// token exchange + JWKS verification also go through the guarded client
	octx := oidc.ClientContext(r.Context(), netguard.Client(10*time.Second))
	token, err := o.config.Exchange(octx, r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, _ := token.Extra("id_token").(string)
	idToken, err := o.verifier.Verify(octx, rawID)
	if err == nil && (nerr != nil || idToken.Nonce != nonceCookie.Value) {
		// bind the ID token to this login: replay of a token minted for another
		// flow (different nonce) is rejected
		http.Error(w, "invalid nonce", http.StatusBadRequest)
		return
	}
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
	// fail closed on an unverified email: findOrCreateOIDCUser links by email to
	// a pre-existing (possibly admin) account, so an IdP that lets users assert
	// an arbitrary unverified address must not be trusted for account linking.
	if !emailVerified(claims) {
		http.Error(w, "email not verified by the identity provider", http.StatusForbidden)
		return
	}
	var admin *bool
	if o.claim != "" {
		_, present := claims[o.claim]
		isAdmin := present && claimMatches(claims, o.claim, o.adminValues)
		// access gate: with a user allowlist configured, only members of an
		// allowed (or admin) group may log in, fail closed on a missing claim
		if len(o.userValues) > 0 && !isAdmin && !(present && claimMatches(claims, o.claim, o.userValues)) {
			http.Error(w, "access denied: not in an allowed group", http.StatusForbidden)
			return
		}
		// admin mapping: only sync when the claim is present, so a
		// misconfigured claim name never demotes anyone
		if len(o.adminValues) > 0 && present {
			admin = &isAdmin
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

// splitCSV turns "a, b,c" into ["a","b","c"], dropping empty entries.
func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// claimMatches reports whether claims[name] equals or contains any of values.
// Handles string, bool and string-array claims (e.g. "groups": ["admin"]).
// emailVerified reports whether the ID token asserts a verified email. Accepts
// the spec's bool true and the string "true" some providers send. A missing
// claim is treated as unverified (fail closed).
func emailVerified(claims map[string]any) bool {
	switch v := claims["email_verified"].(type) {
	case bool:
		return v
	case string:
		return v == "true"
	}
	return false
}

func claimMatches(claims map[string]any, name string, values []string) bool {
	match := func(s string) bool {
		return slices.Contains(values, s)
	}
	switch v := claims[name].(type) {
	case string:
		return match(v)
	case bool:
		return v && match("true")
	case []any:
		for _, e := range v {
			if s, ok := e.(string); ok && match(s) {
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
	// OIDC provisioning is governed by the IdP being configured plus the claim
	// allowlist (oidc_user_values, enforced in CallbackHandler) - not by the
	// password-registration switch. Onboarding via OIDC is by design.
	// first user always becomes admin (an install must never be adminless)
	res, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES (?, (SELECT COUNT(*) = 0 FROM users) OR ?)`,
		email, admin != nil && *admin)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// RegistrationDisabled reports whether open self-registration is off. It is
// closed by default (unset): an admin (or the first-run wizard) must explicitly
// set "false" to open it. The very first account is exempt - see handleRegister.
func RegistrationDisabled(d *sql.DB) bool {
	return db.Setting(d, "registration_disabled") != "false"
}
