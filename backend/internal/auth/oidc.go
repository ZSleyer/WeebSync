package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OIDC is nil when OIDC_ISSUER is unset — email/password only.
type OIDC struct {
	provider *oidc.Provider
	config   oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func NewOIDCFromEnv(ctx context.Context) (*OIDC, error) {
	issuer := os.Getenv("OIDC_ISSUER")
	if issuer == "" {
		return nil, nil
	}
	clientID := os.Getenv("OIDC_CLIENT_ID")
	clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
	redirectURL := os.Getenv("OIDC_REDIRECT_URL") // e.g. https://weebsync.example.com/api/auth/oidc/callback
	if clientID == "" || redirectURL == "" {
		return nil, fmt.Errorf("OIDC_ISSUER set but OIDC_CLIENT_ID or OIDC_REDIRECT_URL missing")
	}
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	cfg := oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  redirectURL,
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	return &OIDC{
		provider: provider,
		config:   cfg,
		verifier: provider.Verifier(&oidc.Config{ClientID: clientID}),
	}, nil
}

// LoginHandler redirects to the identity provider with a random state cookie.
func (o *OIDC) LoginHandler(w http.ResponseWriter, r *http.Request) {
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
func (o *OIDC) CallbackHandler(d *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
		}
		if err := idToken.Claims(&claims); err != nil || claims.Email == "" {
			http.Error(w, "no email claim", http.StatusBadGateway)
			return
		}
		userID, err := findOrCreateOIDCUser(d, claims.Email)
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		if err := CreateSession(d, w, r, userID); err != nil {
			http.Error(w, "session error", http.StatusInternalServerError)
			return
		}
		http.Redirect(w, r, "/", http.StatusFound)
	}
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
	var v string
	d.QueryRow(`SELECT value FROM settings WHERE key = 'registration_disabled'`).Scan(&v)
	return v == "true"
}
