package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

// Session lifetimes. A session ends at whichever comes first: its hard expiry,
// set at sign-in, or a stretch without a single request. "Stay signed in"
// trades the short pair, which follows NIST 800-63B-4 AAL2 (24 h overall),
// for a long one that slides with use: an account in daily use stays signed
// in, a forgotten browser falls out after a month, and nothing outlives a
// quarter without a fresh sign-in. The deviation from AAL1's 30 days overall
// is deliberate and written down in SECURITY.md.
const (
	sessionMax   = 24 * time.Hour
	sessionIdle  = 12 * time.Hour
	rememberMax  = 90 * 24 * time.Hour
	rememberIdle = 30 * 24 * time.Hour
	// last_seen is written at most this often: the middleware runs on every
	// poll and every event stream, and a write per request is real IO
	seenEvery = 10 * time.Minute
)

func idleLimit(remember bool) time.Duration {
	if remember {
		return rememberIdle
	}
	return sessionIdle
}

// IdleCutoffs are the last_seen stamps before which a session has gone idle,
// for the sweep: one for remembered sessions, one for the rest.
func IdleCutoffs(now time.Time) (remembered, short string) {
	return now.Add(-rememberIdle).UTC().Format(time.RFC3339), now.Add(-sessionIdle).UTC().Format(time.RFC3339)
}

// Deployment posture. Both values can come from the environment or from the
// settings table, and the two have to coexist: a container deployment sets
// env, a bare install configures the same thing in the UI. Env wins and the
// UI shows the field locked, the same rule the other env-backed settings
// follow.
//
//	WEEBSYNC_TRUSTED_PROXY - "true" trusts whatever proxy the request arrives
//	  from (the historical meaning of this variable), or a comma-separated
//	  list of proxy IPs/CIDRs to trust.
//	WEEBSYNC_FORCE_HTTPS - always set Secure on cookies (recommended when a
//	  reverse proxy terminates TLS, so the app never sees r.TLS).
type proxyConfig struct {
	// trust the immediate peer whoever it is; only reachable from env, because
	// switching it on without a proxy in front lets any client forge its IP
	trustAll bool
	// the proxies we recognise, and therefore skip when reading the chain
	proxies    IPList
	forceHTTPS bool
}

var proxyCfg atomic.Pointer[proxyConfig]

// captured once; an empty variable counts as unset, matching envLocked()
var (
	envTrustedProxies = os.Getenv("WEEBSYNC_TRUSTED_PROXY")
	envForceHTTPS     = os.Getenv("WEEBSYNC_FORCE_HTTPS")
)

func init() { SetProxyConfig("", false) }

// SetProxyConfig applies the stored settings, with the environment winning
// over both. Called at startup and after every settings save, so a change in
// the UI takes effect without a restart.
func SetProxyConfig(trustedProxies string, forceHTTPS bool) {
	if envTrustedProxies != "" {
		trustedProxies = envTrustedProxies
	}
	if envForceHTTPS != "" {
		forceHTTPS = truthy(envForceHTTPS)
	}
	cfg := &proxyConfig{forceHTTPS: forceHTTPS}
	if v := strings.TrimSpace(trustedProxies); truthy(v) {
		cfg.trustAll = true
	} else {
		cfg.proxies = ParseIPList(v)
	}
	proxyCfg.Store(cfg)
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// trustsPeer reports whether a request arriving from ip may set X-Forwarded-*.
func (c *proxyConfig) trustsPeer(ip string) bool {
	return c.trustAll || c.proxies.Contains(ip)
}

// remoteIP is the address the connection actually came from.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ClientIP returns the caller's IP for per-IP rate limiting, reading
// X-Forwarded-For only when the request arrives from a trusted proxy.
//
// The chain is walked from the right, skipping the proxies we recognise, and
// the first address that is not one of ours wins. Taking the leftmost entry -
// which is what this did before - hands the caller whatever it wrote there:
// everything left of our own proxy's contribution is client-supplied, so a
// single forged header was enough to pick an arbitrary rate-limit bucket or
// to land inside a trusted network. With trustAll there is no list to skip,
// so the rightmost entry wins - the one address our own peer recorded.
func ClientIP(r *http.Request) string {
	remote := remoteIP(r)
	cfg := proxyCfg.Load()
	if cfg == nil || !cfg.trustsPeer(remote) {
		return remote
	}
	parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(parts) - 1; i >= 0; i-- {
		p := strings.TrimSpace(parts[i])
		if p == "" || cfg.proxies.Contains(p) {
			continue
		}
		return p
	}
	return remote
}

type User struct {
	ID      int64  `json:"id"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"isAdmin"`
	// what the account must replace before it may use the app ("password",
	// "passkey"), "" when nothing is due; see users.auth_upgrade
	Upgrade string `json:"-"`
}

// upgradeRoutes are what an account held for an upgrade may still reach: who
// it is, and the routes that carry out the replacement. Everything else
// answers 403 until it is done.
var upgradeRoutes = map[string][]string{
	"password": {"PUT /api/auth/password"},
	"passkey": {"GET /api/auth/webauthn/credentials", "DELETE /api/auth/webauthn/credentials/*",
		"POST /api/auth/webauthn/register/begin", "POST /api/auth/webauthn/register/finish"},
}

func upgradeAllows(kind string, r *http.Request) bool {
	route := r.Method + " " + r.URL.Path
	if route == "GET /api/auth/me" || route == "PUT /api/auth/locale" {
		return true
	}
	for _, p := range upgradeRoutes[kind] {
		if p == route || strings.HasSuffix(p, "/*") && strings.HasPrefix(route, strings.TrimSuffix(p, "*")) {
			return true
		}
	}
	return false
}

type ctxKey struct{}

func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}

// TokenHash is how a session token is stored: callers that list or end
// sessions match the request's own session by it.
func TokenHash(token string) string { return hashToken(token) }

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// CreateSession signs userID in. remember is the "stay signed in" box: without
// it the cookie lives as long as the browser session and the server ends it
// after a day at the latest.
func CreateSession(d *sql.DB, w http.ResponseWriter, r *http.Request, userID int64, remember bool) error {
	return CreateSessionOIDC(d, w, r, userID, "", "", remember)
}

// CreateSessionOIDC is CreateSession for a login that came from the identity
// provider: it remembers which provider session the login belongs to, so a
// back-channel logout can end exactly these sessions and no others. A password
// login passes empty strings and is unaffected.
func CreateSessionOIDC(d *sql.DB, w http.ResponseWriter, r *http.Request, userID int64, sid, sub string, remember bool) error {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	now := time.Now()
	expires := now.Add(sessionMax)
	if remember {
		expires = now.Add(rememberMax)
	}
	// the browser it began in, so the account page can tell sessions apart;
	// capped, it is shown and nothing else
	ua := r.UserAgent()
	if len(ua) > 300 {
		// a cut through a multi-byte character would leave invalid UTF-8
		ua = strings.ToValidUTF8(ua[:300], "")
	}
	stamp := now.UTC().Format(time.RFC3339)
	if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at, oidc_sid, oidc_sub, created_at, user_agent, last_seen, remember, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		hashToken(token), userID, expires.UTC().Format(time.RFC3339), sid, sub, stamp, ua, stamp, remember, ClientIP(r)); err != nil {
		return err
	}
	c := &http.Cookie{Name: "weebsync_session", Value: token, Path: "/"}
	if remember {
		c.Expires = expires
	}
	SetCookie(w, r, c)
	return nil
}

// SessionToken is the raw session token the request carries, "" without one.
func SessionToken(r *http.Request) string {
	if c, err := r.Cookie("weebsync_session"); err == nil {
		return c.Value
	}
	return ""
}

// SetPassword checks and stores a new password, then ends the account's
// sessions, all but the one keepToken names ("" ends every one): whoever
// knew the old password may still be signed in with it. A reset link that is
// still out dies with it. The address counts as verified from here: every
// way to this call vouches for it (an admin, the operator's CLI, the reset
// mail's link, or the signed-in account itself). sql.ErrNoRows when the
// account does not exist.
func SetPassword(d *sql.DB, userID int64, password, keepToken string) error {
	var email string
	if err := d.QueryRow(`SELECT email FROM users WHERE id = ?`, userID).Scan(&email); err != nil {
		return err
	}
	if err := ValidatePassword(password, email); err != nil {
		return err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return db.Tx(d, func(tx *sql.Tx) error {
		res, err := tx.Exec(`UPDATE users SET password_hash = ?, reset_token_hash = '', email_verified = 1,
			auth_upgrade = CASE WHEN auth_upgrade != 'password' THEN auth_upgrade
				WHEN EXISTS (SELECT 1 FROM webauthn_credentials c WHERE c.user_id = users.id AND c.replace_due = 1) THEN 'passkey'
				ELSE '' END WHERE id = ?`, hash, userID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return sql.ErrNoRows
		}
		_, err = tx.Exec(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`, userID, hashToken(keepToken))
		return err
	})
}

// DestroySession deletes the request's session and clears its cookie. The
// cookie goes either way; the error says the session row is still there.
func DestroySession(d *sql.DB, w http.ResponseWriter, r *http.Request) error {
	var delErr error
	if c, err := r.Cookie("weebsync_session"); err == nil {
		_, delErr = d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
	}
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_session", Value: "", Path: "/", MaxAge: -1,
	})
	return delErr
}

// touchSession reports whether a session is still in use, and stamps it as
// seen, from ip, when the last stamp is older than seenEvery. An empty stamp
// (a session from before the column) counts as seen now.
func touchSession(d *sql.DB, token, lastSeen, ip string, remember bool, now time.Time) bool {
	if seen, err := time.Parse(time.RFC3339, lastSeen); err == nil {
		if now.Sub(seen) > idleLimit(remember) {
			return false
		}
		if now.Sub(seen) < seenEvery {
			return true
		}
	}
	// a missed stamp only means the next request stamps again
	_, _ = d.Exec(`UPDATE sessions SET last_seen = ?, ip = ? WHERE token_hash = ?`, now.UTC().Format(time.RFC3339), ip, hashToken(token))
	return true
}

func isHTTPS(r *http.Request) bool {
	cfg := proxyCfg.Load()
	if cfg == nil {
		return r.TLS != nil
	}
	// X-Forwarded-Proto is only worth reading from a proxy we trust, for the
	// same reason X-Forwarded-For is
	return cfg.forceHTTPS || r.TLS != nil ||
		(cfg.trustsPeer(remoteIP(r)) && r.Header.Get("X-Forwarded-Proto") == "https")
}

// ArrivedOverHTTPS reports how this request actually came in: TLS here, or
// HTTPS at a proxy we trust. Unlike IsHTTPS it ignores force_https, for
// links that have to work the way the caller reached us.
func ArrivedOverHTTPS(r *http.Request) bool {
	cfg := proxyCfg.Load()
	return r.TLS != nil || (cfg != nil && cfg.trustsPeer(remoteIP(r)) && r.Header.Get("X-Forwarded-Proto") == "https")
}

// IsHTTPS reports whether the request should be treated as HTTPS, honoring the
// trusted-proxy / force-https env settings. For callers outside this package
// that build redirect origins or set their own cookies.
func IsHTTPS(r *http.Request) bool { return isHTTPS(r) }

// Middleware resolves the session cookie to a user; 401 when required and absent.
func Middleware(d *sql.DB, required bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie("weebsync_session")
			if err == nil {
				var u User
				var expires, lastSeen string
				var isAdmin int
				var remember bool
				err = d.QueryRow(`SELECT u.id, u.email, u.is_admin, u.auth_upgrade, s.expires_at, s.last_seen, s.remember
					FROM sessions s JOIN users u ON u.id = s.user_id
					WHERE s.token_hash = ? AND u.approved = 1`, hashToken(c.Value)).
					Scan(&u.ID, &u.Email, &isAdmin, &u.Upgrade, &expires, &lastSeen, &remember)
				if err == nil {
					now := time.Now()
					if exp, perr := time.Parse(time.RFC3339, expires); perr == nil && exp.After(now) && touchSession(d, c.Value, lastSeen, ClientIP(r), remember, now) {
						if u.Upgrade != "" && !upgradeAllows(u.Upgrade, r) {
							w.Header().Set("Content-Type", "application/json")
							w.WriteHeader(http.StatusForbidden)
							w.Write([]byte(`{"error":"account upgrade required","upgrade":"` + u.Upgrade + `"}`))
							return
						}
						u.IsAdmin = isAdmin == 1
						next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, &u)))
						return
					}
					// the request is refused below either way; a leftover
					// expired row is swept with the next login
					_, _ = d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
				}
			}
			if required {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
