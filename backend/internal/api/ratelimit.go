package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// ipLimiter is a per-IP token-bucket rate limiter for auth endpoints, guarding
// against password brute-force. In-memory only - fine for a single instance;
// a multi-replica deploy would need a shared store.
type ipLimiter struct {
	mu    sync.Mutex
	ips   map[string]*ipEntry
	rate  rate.Limit
	burst int
	// buckets beyond this many trigger a sweep of the full ones
	sweepAt int
	// after a sweep the next one waits until the map has doubled: drained
	// buckets survive a sweep, and a flood of them would otherwise make
	// every new key walk the whole map under the lock
	nextSweep int
	// buckets looked at by sweeps so far (tests count the work with it)
	sweepVisits int
	// trusted returns true for IPs that bypass the limit entirely (admin-
	// configured safe networks). May be nil.
	trusted func(ip string) bool
}

type ipEntry struct {
	lim *rate.Limiter
}

func newIPLimiter(perMinute float64, burst int, trusted func(ip string) bool) *ipLimiter {
	return &ipLimiter{
		ips:     map[string]*ipEntry{},
		rate:    rate.Limit(perMinute / 60.0),
		burst:   burst,
		sweepAt: 10000,
		trusted: trusted,
	}
}

// reset clears an IP's bucket, immediately unblocking it.
func (l *ipLimiter) reset(ip string) {
	l.mu.Lock()
	delete(l.ips, ip)
	l.mu.Unlock()
}

// resetPrefix clears every key that starts with prefix.
func (l *ipLimiter) resetPrefix(prefix string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k := range l.ips {
		if strings.HasPrefix(k, prefix) {
			delete(l.ips, k)
		}
	}
}

// accountKeyNames maps account bucket keys back to the accounts' addresses.
func (s *Server) accountKeyNames() map[string]string {
	out := map[string]string{}
	rows, err := s.DB.Query(`SELECT email FROM users`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var e string
		if rows.Scan(&e) == nil {
			out[accountKey(e)] = e
		}
	}
	_ = rows.Err() // labels only: a cut-off read shows the raw key for the rest
	return out
}

// resetAll clears every tracked IP.
func (l *ipLimiter) resetAll() {
	l.mu.Lock()
	l.ips = map[string]*ipEntry{}
	l.mu.Unlock()
}

type ipStatus struct {
	// the address, an IPv6 /64, or for an account bucket the email it is
	// keyed by
	IP      string `json:"ip"`
	Kind    string `json:"kind" enums:"ip,account"`
	Blocked bool   `json:"blocked"` // no tokens left right now
	Tokens  int    `json:"tokens"`  // remaining, rounded down
}

// status lists tracked keys and whether each is currently rate-limited.
func (l *ipLimiter) status(kind string) []ipStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]ipStatus, 0, len(l.ips))
	for ip, e := range l.ips {
		tok := e.lim.Tokens()
		out = append(out, ipStatus{IP: ip, Kind: kind, Blocked: tok < 1, Tokens: int(tok)})
	}
	return out
}

// limitKey is the bucket an address counts against. An IPv6 client usually
// holds a whole /64 and picks addresses from it at will, so one bucket per
// address would hand it 2^64 of them; the /64 is what it actually controls.
func limitKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || !a.Unmap().Is6() {
		return ip
	}
	p, _ := a.Prefix(64)
	return p.String()
}

// resetKey is limitKey for what an admin passes to unblock: an address, or a
// key exactly as the status list shows it.
func resetKey(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return limitKey(ip)
}

// allow reports whether the ip may proceed, consuming one token.
func (l *ipLimiter) allow(ip string) bool {
	ok, _ := l.take(ip)
	return ok
}

// take spends one attempt; refused, it says how long until the next one.
func (l *ipLimiter) take(ip string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.ips[ip]
	if !ok {
		// An O(n) sweep, amortised: the next one waits until the map has
		// doubled since this one, so each new key pays O(1) on average.
		// A bucket back at full tokens is the same as no bucket, so those
		// go whatever their age; a drained one stays, which is what keeps
		// a blocked address blocked through a flood of one-hit peers.
		if len(l.ips) > max(l.sweepAt, l.nextSweep) {
			for k, v := range l.ips {
				l.sweepVisits++
				if v.lim.Tokens() >= float64(l.burst) {
					delete(l.ips, k)
				}
			}
			l.nextSweep = 2 * len(l.ips)
		}
		e = &ipEntry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.ips[ip] = e
	}
	if e.lim.Allow() {
		return true, 0
	}
	return false, time.Duration((1 - e.lim.Tokens()) / float64(l.rate) * float64(time.Second))
}

// left says how many attempts ip has before the limiter refuses it, and how
// long the pause then lasts (the time one attempt takes to come back). ok is
// false for a caller the limit does not hold for (a trusted network).
func (l *ipLimiter) left(ip string) (n int, pause time.Duration, ok bool) {
	if l.trusted != nil && l.trusted(ip) {
		return 0, 0, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	n = l.burst
	if e, found := l.ips[limitKey(ip)]; found {
		n = max(int(e.lim.Tokens()), 0)
	}
	return n, time.Duration(float64(time.Second) / float64(l.rate)), true
}

// ipTrusted reports whether ipStr falls inside an admin-configured trusted
// network. The setting is a CSV of CIDRs (10.0.0.0/8) or bare IPs - the same
// shape as the trusted-proxy list, so both share one matcher.
func (s *Server) ipTrusted(ipStr string) bool {
	return auth.ParseIPList(db.Setting(s.DB, "trusted_networks")).Contains(ipStr)
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
	out := []ipStatus{}
	if s.authLimiter != nil {
		out = append(out, s.authLimiter.status("ip")...)
	}
	// accounts only while blocked, and by name only when the hash belongs
	// to an account: what else was typed is nobody's to read
	if s.accountLimiter != nil {
		names := s.accountKeyNames()
		for _, st := range s.accountLimiter.status("account") {
			if !st.Blocked {
				continue
			}
			if name, ok := names[st.IP]; ok {
				st.IP = name
			} else {
				st.IP = "?" + st.IP[2:10]
			}
			out = append(out, st)
		}
	}
	writeJSON(w, http.StatusOK, out)
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
	ip := strings.TrimSpace(in.IP)
	for _, l := range []*ipLimiter{s.authLimiter, s.accountLimiter} {
		if l == nil {
			continue
		}
		if in.All {
			l.resetAll()
		} else if ip != "" {
			l.reset(resetKey(ip))
			l.reset(accountKey(strings.ToLower(ip)))
			// an unknown address shows as "?" and the start of its hash
			if strings.HasPrefix(ip, "?") {
				l.resetPrefix("a:" + ip[1:])
			}
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
		if ok, wait := l.take(limitKey(ip)); !ok {
			tooMany(w, wait)
			return
		}
		next(w, r)
	}
}

// tooMany answers 429; the login page tells how long to wait instead of a
// bare "slow down".
func tooMany(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
	writeErr(w, http.StatusTooManyRequests, "too many attempts, slow down")
}

// The account side of the brute-force guard. The per-IP buckets alone let a
// botnet or an IPv6 /64 spread guesses at one account over as many addresses
// as it has; this counts the failures against the account itself. Keyed by
// the email as typed, whether or not an account has it, so a 429 says nothing
// about which addresses are registered. Every attempt spends before it is
// checked - counting only the failures afterwards let parallel guesses all
// pass the check before the first one was counted - and a successful sign-in
// gives the bucket back in full. A bucket refills instead of locking, so a
// stranger can slow an owner down but never shut them out for good - and not
// at all from a trusted network, which is the way back in for an owner whose
// account is under attack.

//
// A browser that once signed in to the account carries a device cookie for
// it (OWASP's device cookies) and is not held by the account's bucket at all:
// otherwise one wrong guess every five minutes from anywhere would keep the
// owner out for as long as the stranger cares to. The per-address limit still
// applies to it.

// accountTake spends one attempt at the account behind email before the
// password or second factor is checked; refused, it says how long to wait.
func (s *Server) accountTake(r *http.Request, email string) time.Duration {
	if s.accountLimiter == nil || s.ipTrusted(auth.ClientIP(r)) || s.knownDevice(r, email) {
		return 0
	}
	if ok, wait := s.accountLimiter.take(accountKey(email)); !ok {
		return max(wait, time.Second)
	}
	return 0
}

// accountSignedIn forgets the failures once the whole sign-in succeeded, and
// marks the browser as one of the account's devices.
func (s *Server) accountSignedIn(w http.ResponseWriter, r *http.Request, email string) {
	if s.accountLimiter != nil {
		s.accountLimiter.reset(accountKey(email))
	}
	if v, ok := s.deviceValue(email, time.Now()); ok {
		auth.SetCookie(w, r, &http.Cookie{Name: deviceCookie, Value: v, Path: "/api/auth", MaxAge: int(deviceMaxAge / time.Second)})
	}
}

const (
	deviceCookie = "weebsync_device"
	deviceMaxAge = 365 * 24 * time.Hour
)

// passwordGeneration changes whenever the account's password does, so a
// device cookie signed under the old one stops counting with it.
func (s *Server) passwordGeneration(email string) string {
	var hash string
	// a failed read hashes "": a cookie signed under the real generation
	// stops matching, so the device counts as unknown (the safe side)
	_ = s.DB.QueryRow(`SELECT password_hash FROM users WHERE email = ?`, email).Scan(&hash)
	sum := sha256.Sum256([]byte(hash))
	return hex.EncodeToString(sum[:8])
}

// deviceValue is a device cookie for email: the address, when it was issued,
// a nonce, and a MAC over those and the password generation. false without
// a key to sign with.
func (s *Server) deviceValue(email string, issued time.Time) (string, bool) {
	nonce := randToken()[:32]
	at := strconv.FormatInt(issued.Unix(), 10)
	mac, err := secret.MAC("device|" + email + "|" + at + "|" + nonce + "|" + s.passwordGeneration(email))
	if err != nil {
		return "", false
	}
	return base64.RawURLEncoding.EncodeToString([]byte(email)) + "." + at + "." + nonce + "." + hex.EncodeToString(mac), true
}

// knownDevice reports whether the request carries a device cookie for email
// that the server signed, within its year, since the last password change.
func (s *Server) knownDevice(r *http.Request, email string) bool {
	c, err := r.Cookie(deviceCookie)
	if err != nil {
		return false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 4 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(raw) != email {
		return false
	}
	at, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Since(time.Unix(at, 0)) > deviceMaxAge {
		return false
	}
	want, err := secret.MAC("device|" + email + "|" + parts[1] + "|" + parts[2] + "|" + s.passwordGeneration(email))
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(parts[3])
	return err == nil && hmac.Equal(got, want)
}

// accountKey is the account bucket's key: a hash of the address as typed, so
// what someone typed into the email field (now and then a password) is not
// kept in memory in the clear.
func accountKey(email string) string {
	sum := sha256.Sum256([]byte("account|" + email))
	return "a:" + hex.EncodeToString(sum[:16])
}
