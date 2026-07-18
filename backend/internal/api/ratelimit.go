package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// ipLimiter is a per-IP token-bucket rate limiter for auth endpoints, guarding
// against password brute-force. In-memory only - fine for a single instance;
// a multi-replica deploy would need a shared store.
type ipLimiter struct {
	mu    sync.Mutex
	ips   map[string]*ipEntry
	rate  rate.Limit
	burst int
	// trusted returns true for IPs that bypass the limit entirely (admin-
	// configured safe networks). May be nil.
	trusted func(ip string) bool
}

type ipEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

func newIPLimiter(perMinute float64, burst int, trusted func(ip string) bool) *ipLimiter {
	return &ipLimiter{
		ips:     map[string]*ipEntry{},
		rate:    rate.Limit(perMinute / 60.0),
		burst:   burst,
		trusted: trusted,
	}
}

// reset clears an IP's bucket, immediately unblocking it.
func (l *ipLimiter) reset(ip string) {
	l.mu.Lock()
	delete(l.ips, ip)
	l.mu.Unlock()
}

// resetAll clears every tracked IP.
func (l *ipLimiter) resetAll() {
	l.mu.Lock()
	l.ips = map[string]*ipEntry{}
	l.mu.Unlock()
}

type ipStatus struct {
	IP      string `json:"ip"`
	Blocked bool   `json:"blocked"` // no tokens left right now
	Tokens  int    `json:"tokens"`  // remaining, rounded down
}

// status lists tracked IPs and whether each is currently rate-limited.
func (l *ipLimiter) status() []ipStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]ipStatus, 0, len(l.ips))
	for ip, e := range l.ips {
		tok := e.lim.Tokens()
		out = append(out, ipStatus{IP: ip, Blocked: tok < 1, Tokens: int(tok)})
	}
	return out
}

// allow reports whether the ip may proceed, consuming one token.
func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.ips[ip]
	if !ok {
		// ponytail: O(n) sweep on new IPs, bounded by the map cap below.
		if len(l.ips) > 10000 {
			cutoff := time.Now().Add(-10 * time.Minute)
			for k, v := range l.ips {
				if v.seen.Before(cutoff) {
					delete(l.ips, k)
				}
			}
		}
		e = &ipEntry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.ips[ip] = e
	}
	e.seen = time.Now()
	return e.lim.Allow()
}

// ipTrusted reports whether ipStr falls inside an admin-configured trusted
// network. The setting is a CSV of CIDRs (10.0.0.0/8) or bare IPs.
func (s *Server) ipTrusted(ipStr string) bool {
	raw := db.Setting(s.DB, "trusted_networks")
	if raw == "" {
		return false
	}
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "/") {
			if _, netw, err := net.ParseCIDR(part); err == nil && netw.Contains(ip) {
				return true
			}
		} else if pip := net.ParseIP(part); pip != nil && pip.Equal(ip) {
			return true
		}
	}
	return false
}

// handleRateLimitList lists the tracked IPs and their current throttle state.
//
// @Summary      List rate-limited IPs
// @Description  Lists the per-IP auth rate-limiter state, whether each IP is currently blocked (admin only).
// @Tags         Auth
// @Produce      json
// @Success      200  {array}   ipStatus
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/auth/ratelimit [get]
func (s *Server) handleRateLimitList(w http.ResponseWriter, r *http.Request) {
	if s.authLimiter == nil {
		writeJSON(w, http.StatusOK, []ipStatus{})
		return
	}
	writeJSON(w, http.StatusOK, s.authLimiter.status())
}

// handleRateLimitReset clears the throttle for one IP or all tracked IPs.
//
// @Summary      Reset rate limiter
// @Description  Unblocks one IP (by ip) or every tracked IP (all=true), admin only.
// @Tags         Auth
// @Accept       json
// @Produce      json
// @Param        request  body      object  true  "ip to reset, or all=true"
// @Success      200  {object}  OkResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/auth/ratelimit/reset [post]
func (s *Server) handleRateLimitReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IP  string `json:"ip"`
		All bool   `json:"all"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if s.authLimiter != nil {
		if in.All {
			s.authLimiter.resetAll()
		} else if in.IP != "" {
			s.authLimiter.reset(in.IP)
		}
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// limit wraps a handler, rejecting callers over the per-IP budget with 429.
// Trusted networks bypass the limit.
func (l *ipLimiter) limit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := auth.ClientIP(r)
		if l.trusted != nil && l.trusted(ip) {
			next(w, r)
			return
		}
		if !l.allow(ip) {
			writeErr(w, http.StatusTooManyRequests, "too many attempts, slow down")
			return
		}
		next(w, r)
	}
}
