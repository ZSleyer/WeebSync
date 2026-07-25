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
)

const sessionTTL = 30 * 24 * time.Hour

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
}

type ctxKey struct{}

func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func CreateSession(d *sql.DB, w http.ResponseWriter, r *http.Request, userID int64) error {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	expires := time.Now().Add(sessionTTL)
	if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), userID, expires.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	SetCookie(w, r, &http.Cookie{
		Name:    "weebsync_session",
		Value:   token,
		Path:    "/",
		Expires: expires,
	})
	return nil
}

func DestroySession(d *sql.DB, w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("weebsync_session"); err == nil {
		d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
	}
	SetCookie(w, r, &http.Cookie{
		Name: "weebsync_session", Value: "", Path: "/", MaxAge: -1,
	})
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
				var expires string
				var isAdmin int
				err = d.QueryRow(`SELECT u.id, u.email, u.is_admin, s.expires_at
					FROM sessions s JOIN users u ON u.id = s.user_id
					WHERE s.token_hash = ?`, hashToken(c.Value)).
					Scan(&u.ID, &u.Email, &isAdmin, &expires)
				if err == nil {
					if exp, perr := time.Parse(time.RFC3339, expires); perr == nil && exp.After(time.Now()) {
						u.IsAdmin = isAdmin == 1
						next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, &u)))
						return
					}
					d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
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
