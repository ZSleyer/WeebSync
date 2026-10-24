package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
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
	// the provider announces S256 PKCE, so every login carries a code
	// challenge (RFC 9700 2.1.1). Only then: a provider that does not know
	// the parameter may refuse the whole login over it.
	pkce bool
}

// Manager holds the current OIDC provider; settings changes rebuild it at
// runtime (no restart). Settings come from the DB with env fallback.
type Manager struct {
	DB  *sql.DB
	mu  sync.RWMutex
	cur *OIDC
	// OnPending is told of an account the provider's first sign-in created
	// that waits for an admin's approval (the api package mails the admins)
	OnPending func(email string)
	// OnSignIn runs after the callback created the session and before the
	// redirect, so the api package can recognise the browser and warn the
	// owner of a new device.
	OnSignIn func(w http.ResponseWriter, r *http.Request, userID int64)
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
	clientSecret := secret.SettingOrEnv(m.DB, "oidc_client_secret", "OIDC_CLIENT_SECRET")
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
	var disc struct {
		Methods []string `json:"code_challenge_methods_supported"`
	}
	provider.Claims(&disc)
	// an issuer reached over https hands out https endpoints: a token or key
	// endpoint over http would carry the client secret and the signing keys
	// in clear text even though the issuer looked safe
	if iu, err := url.Parse(issuer); err == nil && strings.EqualFold(iu.Scheme, "https") {
		ep := provider.Endpoint()
		var more struct {
			JWKS     string `json:"jwks_uri"`
			UserInfo string `json:"userinfo_endpoint"`
		}
		provider.Claims(&more)
		for _, raw := range []string{ep.TokenURL, ep.AuthURL, more.JWKS, more.UserInfo} {
			if raw == "" {
				continue
			}
			if eu, err := url.Parse(raw); err != nil || !strings.EqualFold(eu.Scheme, "https") {
				return fmt.Errorf("oidc discovery: endpoint %s is not https", raw)
			}
		}
	}
	claim := db.SettingOrEnv(m.DB, "oidc_claim", "OIDC_CLAIM")
	scopes := []string{oidc.ScopeOpenID, "email", "profile"}
	if claim != "" && claim != "email" && claim != "profile" {
		// claim usually needs its scope requested (e.g. VoidAuth "groups")
		scopes = append(scopes, claim)
	}
	// the access allowlist: an unreadable setting must not read as "no
	// allowlist", which would let in every identity the provider vouches for
	userValues := os.Getenv("OIDC_USER_VALUES")
	if userValues == "" {
		var uerr error
		if userValues, uerr = db.SettingErr(m.DB, "oidc_user_values"); uerr != nil {
			return fmt.Errorf("oidc allowlist: %w", uerr)
		}
	}
	o := &OIDC{
		config: oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  redirectURL,
			Scopes:       scopes,
		},
		verifier:    newIDTokenVerifier(ctx, provider, issuer, &oidc.Config{ClientID: clientID}),
		claim:       claim,
		adminValues: splitCSV(db.SettingOrEnv(m.DB, "oidc_admin_values", "OIDC_ADMIN_VALUES")),
		userValues:  splitCSV(userValues),
		pkce:        slices.Contains(disc.Methods, "S256"),
	}
	m.mu.Lock()
	m.cur = o
	m.mu.Unlock()
	return nil
}

// AuthMode: "password" (default, password + optional OIDC button),
// "oidc-only" (no password form), "oidc-auto" (login page redirects).
func AuthMode(d *sql.DB) string {
	mode, _ := AuthModeErr(d)
	return mode
}

// AuthModeErr is AuthMode for the callers that gate on it: a setting that
// cannot be read is an error, not the permissive default "password".
func AuthModeErr(d *sql.DB) (string, error) {
	v, err := db.SettingErr(d, "auth_mode")
	if err != nil {
		return "password", err
	}
	switch v {
	case "oidc-only", "oidc-auto":
		return v, nil
	default:
		return "password", nil
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
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_oidc_state", Value: state, Path: "/api/auth/oidc",
		MaxAge: 600,
	})
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_oidc_nonce", Value: nonce, Path: "/api/auth/oidc",
		MaxAge: 600,
	})
	// the login page's "stay signed in" box, carried over the round trip
	remember := "0"
	if r.URL.Query().Get("remember") == "1" {
		remember = "1"
	}
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_oidc_remember", Value: remember, Path: "/api/auth/oidc",
		MaxAge: 600,
	})
	opts := []oauth2.AuthCodeOption{oidc.Nonce(nonce)}
	if o.pkce {
		// the verifier stays with this browser; a stolen code alone cannot
		// be exchanged without it
		verifier := oauth2.GenerateVerifier()
		SetCookie(w, r, &http.Cookie{
			Name: "weebsync_oidc_pkce", Value: verifier, Path: "/api/auth/oidc",
			MaxAge: 600,
		})
		opts = append(opts, oauth2.S256ChallengeOption(verifier))
	}
	http.Redirect(w, r, o.config.AuthCodeURL(state, opts...), http.StatusFound)
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
// callbackFail sends a failed sign-in back to the app with a code the login
// page explains in the UI language. A bare error text on the callback URL left
// the user with no way back, and in auto-redirect mode going back to the app
// went straight to the provider again.
func callbackFail(w http.ResponseWriter, r *http.Request, code string) {
	slog.Info("oidc sign-in refused", "reason", code)
	http.Redirect(w, r, "/?oidc_error="+code, http.StatusFound)
}

func (m *Manager) CallbackHandler(w http.ResponseWriter, r *http.Request) {
	o := m.Get()
	if o == nil {
		callbackFail(w, r, "not_configured")
		return
	}
	// an allowlist without the claim to check it against gates nobody, yet
	// would provision every identity the provider vouches for (the settings
	// refuse the combination; the environment can still set it)
	if len(o.userValues) > 0 && o.claim == "" {
		slog.Warn("oidc allowed values are set but no claim to check them against")
		callbackFail(w, r, "not_allowed")
		return
	}
	stateCookie, err := r.Cookie("weebsync_oidc_state")
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		callbackFail(w, r, "invalid_state")
		return
	}
	nonceCookie, nerr := r.Cookie("weebsync_oidc_nonce")
	// state + nonce are single-use: invalidate both so the callback URL
	// cannot be replayed within the cookies' lifetime
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_oidc_state", Value: "", Path: "/api/auth/oidc",
		MaxAge: -1,
	})
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_oidc_nonce", Value: "", Path: "/api/auth/oidc",
		MaxAge: -1,
	})
	var exchangeOpts []oauth2.AuthCodeOption
	if o.pkce {
		pc, perr := r.Cookie("weebsync_oidc_pkce")
		SetCookie(w, r, &http.Cookie{Name: "weebsync_oidc_pkce", Value: "", Path: "/api/auth/oidc", MaxAge: -1})
		if perr != nil || pc.Value == "" {
			callbackFail(w, r, "invalid_state")
			return
		}
		exchangeOpts = append(exchangeOpts, oauth2.VerifierOption(pc.Value))
	}
	// token exchange + JWKS verification also go through the guarded client
	octx := oidc.ClientContext(r.Context(), netguard.Client(10*time.Second))
	token, err := o.config.Exchange(octx, r.URL.Query().Get("code"), exchangeOpts...)
	if err != nil {
		callbackFail(w, r, "exchange_failed")
		return
	}
	rawID, _ := token.Extra("id_token").(string)
	idToken, err := o.verifier.Verify(octx, rawID)
	if err == nil && (nerr != nil || idToken.Nonce != nonceCookie.Value) {
		// bind the ID token to this login: replay of a token minted for another
		// flow (different nonce) is rejected
		callbackFail(w, r, "invalid_state")
		return
	}
	if err != nil {
		callbackFail(w, r, "verify_failed")
		return
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		callbackFail(w, r, "verify_failed")
		return
	}
	email, _ := claims["email"].(string)
	// as sent: findOrCreateOIDCUserNew lowercases it, and also looks for an
	// account an earlier release stored in this spelling
	email = strings.TrimSpace(email)
	if email == "" {
		callbackFail(w, r, "no_email")
		return
	}
	// fail closed on an unverified email: findOrCreateOIDCUser links by email to
	// a pre-existing (possibly admin) account, so an IdP that lets users assert
	// an arbitrary unverified address must not be trusted for account linking.
	if !emailVerified(claims) {
		callbackFail(w, r, "email_unverified")
		return
	}
	var admin *bool
	if o.claim != "" {
		_, present := claims[o.claim]
		isAdmin := present && claimMatches(claims, o.claim, o.adminValues)
		// access gate: with a user allowlist configured, only members of an
		// allowed (or admin) group may log in, fail closed on a missing claim
		if len(o.userValues) > 0 && !isAdmin && !(present && claimMatches(claims, o.claim, o.userValues)) {
			callbackFail(w, r, "not_allowed")
			return
		}
		// admin mapping: only sync when the claim is present, so a
		// misconfigured claim name never demotes anyone
		if len(o.adminValues) > 0 && present {
			admin = &isAdmin
		}
	}
	// no account yet: the identity coming back becomes the admin, so only
	// for the browser that proved it holds the setup code
	var users int
	if err := m.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil || (users == 0 && !validSetupProof(r)) {
		callbackFail(w, r, "setup_token")
		return
	}
	SetCookie(w, r, &http.Cookie{Name: setupProofCookie, Value: "", Path: "/api/auth/oidc", MaxAge: -1})
	userID, created, err := findOrCreateOIDCUserNew(m.DB, email, admin, len(o.userValues) > 0)
	if errors.Is(err, errNotProvisioned) {
		callbackFail(w, r, "not_provisioned")
		return
	}
	if err != nil {
		slog.Error("oidc user lookup failed", "err", err)
		callbackFail(w, r, "session_error")
		return
	}
	// the provider vouches for who it is, an admin for whether they may in
	var approved bool
	if err := m.DB.QueryRow(`SELECT approved FROM users WHERE id = ?`, userID).Scan(&approved); err != nil {
		slog.Error("oidc approval lookup failed", "err", err)
		callbackFail(w, r, "session_error")
		return
	}
	if !approved {
		if created && m.OnPending != nil {
			m.OnPending(email)
		}
		callbackFail(w, r, "not_approved")
		return
	}
	// the provider's session id ties our session to the one at the IdP, so a
	// logout there can end this one too (see BackchannelLogoutHandler)
	sid, _ := claims["sid"].(string)
	rc, _ := r.Cookie("weebsync_oidc_remember")
	SetCookie(w, r, &http.Cookie{Name: "weebsync_oidc_remember", Value: "", Path: "/api/auth/oidc", MaxAge: -1})
	if err := CreateSessionOIDC(m.DB, w, r, userID, sid, idToken.Subject, rc != nil && rc.Value == "1"); err != nil {
		callbackFail(w, r, "session_error")
		return
	}
	if m.OnSignIn != nil {
		m.OnSignIn(w, r, userID)
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
// provider on every login; the last remaining admin is never demoted. gated
// reports whether an access allowlist (oidc_user_values) restricts who may log
// in: without one, a new identity is only auto-provisioned as the first account
// (bootstrap) - otherwise an OIDC-configured instance with no allowlist would
// let any IdP identity in, which contradicts closed-by-default registration.
// errNotProvisioned: a new identity on an instance without an allowed-group
// list, which only links existing accounts.
var errNotProvisioned = errors.New("oidc provisioning requires an allowed-group allowlist")

func findOrCreateOIDCUser(d *sql.DB, email string, admin *bool, gated bool) (int64, error) {
	id, _, err := findOrCreateOIDCUserNew(d, email, admin, gated)
	return id, err
}

// normalizeEmail is the stored spelling of an address the provider sends:
// the password sign-in lowercases what is typed, and an account stored with
// capitals counted its failures and its device cookie under another key.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// findOrCreateOIDCUserNew is findOrCreateOIDCUser that also reports whether
// the account was created just now.
func findOrCreateOIDCUserNew(d *sql.DB, email string, admin *bool, gated bool) (int64, bool, error) {
	sent := strings.TrimSpace(email)
	email = normalizeEmail(email)
	var id int64
	err := d.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) && sent != email {
		// stored by an earlier release in the provider's spelling: NOCASE
		// folds ASCII only, so a non-ASCII capital misses the lowercase lookup
		err = d.QueryRow(`SELECT id FROM users WHERE email = ?`, sent).Scan(&id)
	}
	if err == nil {
		if admin != nil {
			if !*admin {
				var others int
				if err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE is_admin = 1 AND id != ?`, id).Scan(&others); err != nil || others == 0 {
					slog.Warn("oidc admin mapping: not demoting the last admin", "email", email)
					return id, false, nil
				}
			}
			if _, err := d.Exec(`UPDATE users SET is_admin = ? WHERE id = ?`, *admin, id); err != nil {
				return 0, false, err
			}
			// the provider's groups make it an admin: nobody else could
			// approve it more surely
			if *admin {
				if _, err := d.Exec(`UPDATE users SET approved = 1 WHERE id = ?`, id); err != nil {
					return 0, false, err
				}
			}
		}
		return id, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}
	// new identity: provision only when access is actually gated by an allowlist,
	// or when this is the very first account (an install must never be adminless).
	if !gated {
		var users int
		if err := d.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
			return 0, false, err
		}
		if users > 0 {
			return 0, false, errNotProvisioned
		}
	}
	// first user always becomes admin (an install must never be adminless)
	// verified: the callback only gets here with the provider's email_verified;
	// unverified, the account never got a notification mail
	// approved: the first account (the admin) and one the provider's groups
	// make an admin; anyone else waits for an admin to let them in
	res, err := d.Exec(`INSERT INTO users (email, is_admin, email_verified, upgrade_dims, approved) VALUES (?, (SELECT COUNT(*) = 0 FROM users) OR ?, 1, 'res,sub,dub,soft', (SELECT COUNT(*) = 0 FROM users) OR ?)`,
		email, admin != nil && *admin, admin != nil && *admin)
	if err != nil {
		return 0, false, err
	}
	newID, err := res.LastInsertId()
	return newID, true, err
}

// RegistrationDisabled reports whether open self-registration is off. It is
// closed by default (unset): an admin (or the first-run wizard) must explicitly
// set "false" to open it. The very first account is exempt - see handleRegister.
func RegistrationDisabled(d *sql.DB) bool {
	return db.Setting(d, "registration_disabled") != "false"
}

// The first-run proof for the provider's round trip. With no account yet the
// first identity the provider sends back becomes the admin, so that sign-in
// has to come from whoever holds the setup code: the api package checks the
// code and calls SetSetupProof, and the callback creates the first account
// only with the proof. Signed with a key derived from the instance secret.
const setupProofCookie = "weebsync_oidc_setup"

// SetSetupProof hands the browser the proof, good for ten minutes.
func SetSetupProof(w http.ResponseWriter, r *http.Request) error {
	nonce, err := randHex()
	if err != nil {
		return err
	}
	at := strconv.FormatInt(time.Now().Unix(), 10)
	mac, err := secret.MAC("oidc-setup|" + at + "|" + nonce)
	if err != nil {
		return err
	}
	SetCookie(w, r, &http.Cookie{Name: setupProofCookie, Value: at + "." + nonce + "." + hex.EncodeToString(mac), Path: "/api/auth/oidc", MaxAge: 600})
	return nil
}

func validSetupProof(r *http.Request) bool {
	c, err := r.Cookie(setupProofCookie)
	if err != nil {
		return false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return false
	}
	at, err := strconv.ParseInt(parts[0], 10, 64)
	// a stamp from the future never ages out, so only a little clock skew passes
	if age := time.Since(time.Unix(at, 0)); err != nil || age > 10*time.Minute || age < -time.Minute {
		return false
	}
	sig := parts[2]
	want, err := secret.MAC("oidc-setup|" + parts[0] + "|" + parts[1])
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(sig)
	return err == nil && hmac.Equal(got, want)
}
