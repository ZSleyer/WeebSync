package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// Device pairing for read-only clients such as a TV launcher, modelled on the
// OAuth 2.0 device authorization grant, RFC 8628
// (https://www.rfc-editor.org/rfc/rfc8628, read 2026-10-25):
//
//   - POST /api/devices/pair (no auth) hands out a device code (secret, kept
//     by the TV) and a user code (shown on the screen).
//   - A signed-in user types the user code into POST /api/devices/approve.
//     There is no list of pending pairings: only the code on the screen binds
//     the device, so nobody approves a stranger's request blindly.
//   - The TV polls POST /api/devices/token with the device code and receives
//     its token once, after the approval.
//
// The token endpoint answers the RFC's states in this API's error body,
// {"error": "<code>"}, which is the shape of RFC 6749 section 5.2 already,
// all with HTTP 400 as that section asks: authorization_pending, slow_down
// (with the raised interval), access_denied, expired_token, invalid_grant
// (unknown or already used device code) and invalid_request.
const (
	// RFC 8628 section 6.1: base 20, no vowels, no digits, case-insensitive
	userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ"
	userCodeLen      = 8 // 20^8, about 34.5 bits (section 5.1)
	// long enough to fetch the phone and sign in, short enough that a code
	// sent around for phishing goes stale (section 5.4)
	pairingTTL = 10 * time.Minute
	// section 3.5: the default 5 s, and slow_down adds 5 s each time
	pairInterval    = 5
	pairIntervalMax = 60
	// an expired pairing stays this long, so the TV hears expired_token
	// rather than invalid_grant; then the next pair sweeps it
	pairingKeep = time.Hour
	// open pairings one address (an IPv6 /64) may hold, and one IPv6 /48:
	// a household pairs one TV at a time, a block of /64s is one party
	maxPendingPerSource = 5
	maxPendingPerWide   = 20
	// a pairing nobody polled this long after it began has no TV behind it
	// (a real one polls within its interval): the global cap evicts those
	pairAbandonedAfter = 15 * time.Second
	tvScope            = "tv:read"
	// how often a token's last use is written at most
	deviceSeenEvery = time.Minute
	deviceNameMax   = 64
)

// pendingPairingCap bounds the open pairings of the whole instance (a var so
// tests can reach it without 500 requests).
var pendingPairingCap = 500

// pairSources are the keys a pairing counts against: the limiter's (the
// address, an IPv6 /64) and the IPv6 /48 around it (the same key for IPv4).
func pairSources(ip string) (source, wide string) {
	source = limitKey(ip)
	a, err := netip.ParseAddr(ip)
	if err != nil || !a.Unmap().Is6() {
		return source, source
	}
	p, _ := a.Prefix(48)
	return source, p.String()
}

// newUserCode is a fresh "XXXX-XXXX" code in userCodeAlphabet.
func newUserCode() (string, error) {
	sym, err := randFrom(rand.Reader, userCodeAlphabet, userCodeLen)
	if err != nil {
		return "", err
	}
	return string(sym[:4]) + "-" + string(sym[4:]), nil
}

// normalizeUserCode is what a typed code is compared as (section 6.1):
// upper-cased, everything outside the alphabet dropped (dashes, spaces, a
// stray character), and then exactly userCodeLen symbols or "". Storing and
// looking up both go through it.
func normalizeUserCode(in string) string {
	var b strings.Builder
	for _, r := range in {
		r = unicode.ToUpper(r)
		if r < unicode.MaxASCII && strings.ContainsRune(userCodeAlphabet, r) {
			b.WriteRune(r)
		}
	}
	if b.Len() != userCodeLen {
		return ""
	}
	return b.String()
}

// userCodeHash is how a user code is stored and looked up.
func userCodeHash(code string) string { return auth.TokenHash("user-code:" + normalizeUserCode(code)) }

// randomSecret is 256 random bits, hex: the device code and the token.
func randomSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// deviceName keeps a name the user or the device gave readable: trimmed,
// control characters out, at most deviceNameMax characters.
func deviceName(in string) string {
	out := []rune{}
	for _, r := range strings.TrimSpace(in) {
		if unicode.IsControl(r) {
			continue
		}
		if len(out) == deviceNameMax {
			break
		}
		out = append(out, r)
	}
	return strings.TrimSpace(string(out))
}

type devicePairRequest struct {
	// Name the device calls itself, shown in the device list; optional
	Name string `json:"name,omitempty" example:"Kotatsu"`
}

type devicePairResponse struct {
	// UserCode is shown on the TV and typed in by the user, "XXXX-XXXX"
	UserCode string `json:"userCode" example:"WDJB-MJHT"`
	// DeviceCode is the TV's secret for polling the token endpoint
	DeviceCode string `json:"deviceCode"`
	// ExpiresAt is when both codes stop working, unix seconds
	ExpiresAt int64 `json:"expiresAt"`
	// Interval is the seconds to wait between two token requests
	Interval int `json:"interval" example:"5"`
}

// handleDevicePair starts a pairing.
//
//	@Summary		Start device pairing
//	@Description	Unauthenticated, rate-limited per address. Starts an RFC 8628 style pairing for a read-only device (a TV): returns the user code to show, the device code to poll POST /api/devices/token with, its expiry (about 10 minutes) and the polling interval. Only hashes of both codes are stored. The body is optional.
//	@Tags			Devices
//	@Accept			json
//	@Produce		json
//	@Param			request	body		devicePairRequest	false	"optional device name"
//	@Success		200		{object}	devicePairResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		429		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Router			/api/devices/pair [post]
func (s *Server) handleDevicePair(w http.ResponseWriter, r *http.Request) {
	var in devicePairRequest
	if r.ContentLength != 0 && !readJSONLimit(w, r, &in, 4<<10) {
		return
	}
	now := time.Now()
	// best-effort sweep: an expired row left over is refused on read anyway
	_, _ = s.DB.Exec(`DELETE FROM device_pairings WHERE expires_at < ?`, now.Add(-pairingKeep).Unix())
	ip := auth.ClientIP(r)
	source, wide := pairSources(ip)
	deviceCode, err := randomSecret()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "rng error")
		return
	}
	expires := now.Add(pairingTTL).Unix()
	// the room check and the insert are one transaction: it takes the write
	// lock at BEGIN (_txlock=immediate), so a burst from one source cannot
	// all pass the count before any of them is written
	var userCode string
	err = db.Tx(s.DB, func(tx *sql.Tx) error {
		ok, err := pairingRoom(tx, now, source, wide)
		if err != nil {
			return err
		}
		if !ok {
			return errNoPairingRoom
		}
		// a user code can collide with a live one (20^8 codes): draw again;
		// a refused insert ends only its statement, not the transaction
		for range 3 {
			code, err := newUserCode()
			if err != nil {
				return err
			}
			_, err = tx.Exec(`INSERT INTO device_pairings (device_code_hash, user_code_hash, name, created_at, expires_at, poll_interval, ip, source, source_wide)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				auth.TokenHash(deviceCode), userCodeHash(code), deviceName(in.Name), now.Unix(), expires, pairInterval, ip, source, wide)
			if db.IsUnique(err) {
				continue
			}
			if err != nil {
				return err
			}
			userCode = code
			return nil
		}
		return errNoUserCode
	})
	switch {
	case errors.Is(err, errNoPairingRoom):
		tooMany(w, time.Minute)
	case errors.Is(err, errNoUserCode):
		writeErr(w, http.StatusInternalServerError, "could not draw a free user code")
	case err != nil:
		dbErr(w, err)
	default:
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, devicePairResponse{UserCode: userCode, DeviceCode: deviceCode, ExpiresAt: expires, Interval: pairInterval})
	}
}

var (
	errNoPairingRoom = errors.New("no room for another pairing")
	errNoUserCode    = errors.New("no free user code")
)

// pairingRoom says whether a new pairing from source fits: the source and its
// IPv6 /48 below their share of open pairings, and the instance below its cap.
// Only pending rows count; approved and denied ones wait for one last poll
// and hold nothing. At the cap, the oldest pairings no device ever polled are
// evicted first: a real TV polls within seconds, so those are filler.
func pairingRoom(tx *sql.Tx, now time.Time, source, wide string) (bool, error) {
	live := now.Unix()
	var own, block, all int
	if err := tx.QueryRow(`SELECT
			COUNT(*) FILTER (WHERE source = ?),
			COUNT(*) FILTER (WHERE source_wide = ?),
			COUNT(*)
		FROM device_pairings WHERE status = 'pending' AND expires_at > ?`, source, wide, live).Scan(&own, &block, &all); err != nil {
		return false, err
	}
	if own >= maxPendingPerSource || block >= maxPendingPerWide {
		return false, nil
	}
	if all < pendingPairingCap {
		return true, nil
	}
	res, err := tx.Exec(`DELETE FROM device_pairings WHERE id IN (
			SELECT id FROM device_pairings
			WHERE status = 'pending' AND expires_at > ? AND last_poll_ms = 0 AND created_at <= ?
			ORDER BY created_at, id LIMIT ?)`,
		live, now.Add(-pairAbandonedAfter).Unix(), all-pendingPairingCap+1)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return all-int(n) < pendingPairingCap, nil
}

type deviceTokenRequest struct {
	DeviceCode string `json:"deviceCode"`
}

// deviceTokenResponse is the token, handed out once.
type deviceTokenResponse struct {
	// Token goes into "Authorization: Bearer <token>" on /api/tv/*
	Token string `json:"token"`
	Scope string `json:"scope" example:"tv:read"`
}

// deviceTokenError is the token endpoint's refusal: error is an RFC 8628 /
// RFC 6749 error code.
type deviceTokenError struct {
	Error string `json:"error" enums:"authorization_pending,slow_down,access_denied,expired_token,invalid_grant,invalid_request"`
	// Interval is the raised polling interval in seconds, with slow_down only
	Interval int `json:"interval,omitempty"`
}

func tokenErr(w http.ResponseWriter, code string, interval int) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusBadRequest, deviceTokenError{Error: code, Interval: interval})
}

// handleDeviceToken is the TV's poll.
//
//	@Summary		Poll for the device token
//	@Description	Unauthenticated, rate-limited per address. The device polls with its device code, waiting `interval` seconds between requests. Every refusal is HTTP 400 with an RFC 8628 error code in `error`: authorization_pending (keep polling), slow_down (polled too fast; `interval` is the new interval, keep polling), access_denied (the user declined; stop), expired_token (the pairing ran out; stop, start a new one when the user asks), invalid_grant (unknown or already used device code; stop), invalid_request (no device code). After the approval the token is returned exactly once and the device code is used up.
//	@Tags			Devices
//	@Accept			json
//	@Produce		json
//	@Param			request	body		deviceTokenRequest	true	"the device code from the pairing"
//	@Success		200		{object}	deviceTokenResponse
//	@Failure		400		{object}	deviceTokenError
//	@Failure		415		{object}	ErrorResponse
//	@Failure		429		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Router			/api/devices/token [post]
func (s *Server) handleDeviceToken(w http.ResponseWriter, r *http.Request) {
	var in deviceTokenRequest
	if !readJSONLimit(w, r, &in, 4<<10) {
		return
	}
	if strings.TrimSpace(in.DeviceCode) == "" {
		tokenErr(w, "invalid_request", 0)
		return
	}
	hash := auth.TokenHash(in.DeviceCode)
	var (
		id, expires, lastPoll int64
		interval              int
		status, name, oidcSub string
		userID                sql.NullInt64
	)
	err := s.DB.QueryRow(`SELECT id, status, user_id, name, expires_at, poll_interval, last_poll_ms, oidc_sub
		FROM device_pairings WHERE device_code_hash = ?`, hash).
		Scan(&id, &status, &userID, &name, &expires, &interval, &lastPoll, &oidcSub)
	if errors.Is(err, sql.ErrNoRows) {
		tokenErr(w, "invalid_grant", 0)
		return
	}
	if err != nil {
		dbErr(w, err)
		return
	}
	now := time.Now()
	if expires <= now.Unix() {
		if _, err := s.DB.Exec(`DELETE FROM device_pairings WHERE id = ?`, id); err != nil {
			dbErr(w, err)
			return
		}
		tokenErr(w, "expired_token", 0)
		return
	}
	// faster than the interval: slow_down, and the interval grows by 5 s for
	// this and every later request (section 3.5)
	if lastPoll > 0 && now.UnixMilli()-lastPoll < int64(interval)*1000 {
		interval = min(interval+5, pairIntervalMax)
		if _, err := s.DB.Exec(`UPDATE device_pairings SET poll_interval = ?, last_poll_ms = ? WHERE id = ?`, interval, now.UnixMilli(), id); err != nil {
			dbErr(w, err)
			return
		}
		tokenErr(w, "slow_down", interval)
		return
	}
	switch status {
	case "pending":
		if _, err := s.DB.Exec(`UPDATE device_pairings SET last_poll_ms = ? WHERE id = ?`, now.UnixMilli(), id); err != nil {
			dbErr(w, err)
			return
		}
		tokenErr(w, "authorization_pending", 0)
		return
	case "denied":
		if _, err := s.DB.Exec(`DELETE FROM device_pairings WHERE id = ?`, id); err != nil {
			dbErr(w, err)
			return
		}
		tokenErr(w, "access_denied", 0)
		return
	}
	// approved: the row goes and the token comes in one step, so two polls
	// racing for it cannot both get one
	if !userID.Valid {
		tokenErr(w, "invalid_grant", 0)
		return
	}
	token, err := randomSecret()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "rng error")
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		dbErr(w, err)
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`DELETE FROM device_pairings WHERE id = ? AND status = 'approved'`, id)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			dbErr(w, err)
			return
		}
		tokenErr(w, "invalid_grant", 0)
		return
	}
	if _, err := tx.Exec(`INSERT INTO device_tokens (user_id, token_hash, name, scope, created_at, oidc_sub) VALUES (?, ?, ?, ?, ?, ?)`,
		userID.Int64, auth.TokenHash(token), name, tvScope, now.UTC().Format(time.RFC3339), oidcSub); err != nil {
		dbErr(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		dbErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, deviceTokenResponse{Token: token, Scope: tvScope})
}

type deviceApproveRequest struct {
	// UserCode as shown on the device; case, dashes and spaces do not matter
	UserCode string `json:"userCode" example:"WDJB-MJHT"`
	// Name for the device in the list; optional, the device's own otherwise
	Name string `json:"name,omitempty"`
}

type deviceApproveResponse struct {
	// Name the device will be listed under
	Name string `json:"name"`
}

// findPairing reserves one approval attempt of the account and finds the
// pending pairing behind a typed code. It writes the refusal itself.
func (s *Server) findPairing(w http.ResponseWriter, r *http.Request, u *auth.User) (id int64, name string, ok bool) {
	var in deviceApproveRequest
	if !readJSONLimit(w, r, &in, 4<<10) {
		return 0, "", false
	}
	// every attempt counts against the account, a wrong code and a right
	// one alike, before anything is looked up: no oracle while capped
	if allowed, wait := s.approveUserLimiter.take("u:" + strconv.FormatInt(u.ID, 10)); !allowed {
		tooMany(w, wait)
		return 0, "", false
	}
	code := normalizeUserCode(in.UserCode)
	if code == "" {
		writeErr(w, http.StatusBadRequest, "invalid code")
		return 0, "", false
	}
	err := s.DB.QueryRow(`SELECT id, name FROM device_pairings
		WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`, userCodeHash(code), time.Now().Unix()).Scan(&id, &name)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "unknown or expired code")
		return 0, "", false
	}
	if err != nil {
		dbErr(w, err)
		return 0, "", false
	}
	if n := deviceName(in.Name); n != "" {
		name = n
	}
	return id, name, true
}

// handleDeviceApprove binds a pairing to the signed-in user.
//
//	@Summary		Approve a device
//	@Description	The signed-in user (any role) types the code the device shows. Binds the pairing to that user; the device's next poll receives a read-only tv:read token. Rate-limited per address and per account (fails closed). 404 for a code that is unknown, expired or already used.
//	@Tags			Devices
//	@Accept			json
//	@Produce		json
//	@Param			request	body		deviceApproveRequest	true	"the code shown on the device"
//	@Success		200		{object}	deviceApproveResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		401		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		429		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/devices/approve [post]
func (s *Server) handleDeviceApprove(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, name, ok := s.findPairing(w, r, u)
	if !ok {
		return
	}
	if name == "" {
		name = "TV"
	}
	// the provider login that approves, if it is one: its back-channel
	// logout by subject revokes the device later, session or not
	var oidcSub string
	if err := s.DB.QueryRow(`SELECT oidc_sub FROM sessions WHERE token_hash = ?`, auth.TokenHash(auth.SessionToken(r))).Scan(&oidcSub); err != nil {
		dbErr(w, err)
		return
	}
	res, err := s.DB.Exec(`UPDATE device_pairings SET status = 'approved', user_id = ?, name = ?, oidc_sub = ? WHERE id = ? AND status = 'pending'`, u.ID, name, oidcSub, id)
	if err != nil {
		dbErr(w, err)
		return
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			dbErr(w, err)
			return
		}
		writeErr(w, http.StatusNotFound, "unknown or expired code")
		return
	}
	writeJSON(w, http.StatusOK, deviceApproveResponse{Name: name})
}

// handleDeviceDeny declines a pairing.
//
//	@Summary		Decline a device
//	@Description	The signed-in user declines the pairing whose code a device shows; its next poll answers access_denied. Counts against the same limits as approving.
//	@Tags			Devices
//	@Accept			json
//	@Produce		json
//	@Param			request	body		deviceApproveRequest	true	"the code shown on the device"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		401		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		429		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/devices/deny [post]
func (s *Server) handleDeviceDeny(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.findPairing(w, r, auth.UserFrom(r.Context()))
	if !ok {
		return
	}
	res, err := s.DB.Exec(`UPDATE device_pairings SET status = 'denied' WHERE id = ? AND status = 'pending'`, id)
	if err != nil {
		dbErr(w, err)
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		dbErr(w, err)
		return
	}
	// approved, denied or expired in the meantime: nothing was declined
	if n != 1 {
		writeErr(w, http.StatusNotFound, "unknown or expired code")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// deviceInfo is one paired device of the account.
type deviceInfo struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Scope      string `json:"scope" example:"tv:read"`
	CreatedAt  string `json:"createdAt"`            // RFC 3339
	LastUsedAt string `json:"lastUsedAt,omitempty"` // RFC 3339, stamped at most once a minute; absent = never used
	LastIP     string `json:"lastIp,omitempty"`     // the address it was last used from
}

// handleDevicesList lists the caller's own devices.
//
//	@Summary		List paired devices
//	@Description	The signed-in user's own paired devices, newest first. Admins see only their own as well. Pending pairings are never listed.
//	@Tags			Devices
//	@Produce		json
//	@Success		200	{array}		deviceInfo
//	@Failure		401	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/devices [get]
func (s *Server) handleDevicesList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, name, scope, created_at, last_used_at, last_ip FROM device_tokens
		WHERE user_id = ? ORDER BY id DESC`, u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	defer rows.Close()
	out := []deviceInfo{}
	for rows.Next() {
		var d deviceInfo
		if err := rows.Scan(&d.ID, &d.Name, &d.Scope, &d.CreatedAt, &d.LastUsedAt, &d.LastIP); err != nil {
			dbErr(w, err)
			return
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		dbErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDeviceDelete revokes one of the caller's devices.
//
//	@Summary		Revoke a device
//	@Description	Revokes one of the signed-in user's own devices; its token is refused from then on. 404 for an id that is not one of the caller's devices.
//	@Tags			Devices
//	@Produce		json
//	@Param			id	path		int	true	"device id"
//	@Success		200	{object}	OkResponse
//	@Failure		401	{object}	ErrorResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/devices/{id} [delete]
func (s *Server) handleDeviceDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	res, err := s.DB.Exec(`DELETE FROM device_tokens WHERE id = ? AND user_id = ?`, pathID(r), u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		dbErr(w, err)
		return
	}
	if n == 0 {
		writeErr(w, http.StatusNotFound, "device not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

type tvUserKey struct{}

// tvUser is the account a device token belongs to; only the /api/tv/*
// handlers read it, and nothing else puts it in a context.
func tvUser(ctx context.Context) *auth.User {
	u, _ := ctx.Value(tvUserKey{}).(*auth.User)
	return u
}

// tvAuth admits a request carrying a device token with the tv:read scope.
// It guards the /api/tv/* routes only; no other route reads device tokens,
// and these take nothing else (no session cookie). The token is looked up by
// its sha256, so no comparison runs over the secret itself. An account
// deleted (the token goes with it) or not approved is refused like a revoked
// token.
func (s *Server) tvAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		tok = strings.TrimSpace(tok)
		if !ok || tok == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="weebsync", scope="`+tvScope+`"`)
			writeErr(w, http.StatusUnauthorized, "device token required")
			return
		}
		var (
			id           int64
			u            auth.User
			isAdmin      int
			scope, used  string
			upgradeState string
		)
		err := s.DB.QueryRow(`SELECT t.id, u.id, u.email, u.is_admin, u.auth_upgrade, t.scope, t.last_used_at
			FROM device_tokens t JOIN users u ON u.id = t.user_id
			WHERE t.token_hash = ? AND u.approved = 1`, auth.TokenHash(tok)).
			Scan(&id, &u.ID, &u.Email, &isAdmin, &upgradeState, &scope, &used)
		if errors.Is(err, sql.ErrNoRows) || err == nil && !hasScope(scope, tvScope) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="weebsync", error="invalid_token"`)
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		if err != nil {
			dbErr(w, err)
			return
		}
		// an account held until it replaces its password or passkey is held
		// here too, as on every session route
		if upgradeState != "" {
			writeErr(w, http.StatusForbidden, "account upgrade required")
			return
		}
		u.IsAdmin = isAdmin == 1
		now := time.Now()
		if t, perr := time.Parse(time.RFC3339, used); perr != nil || now.Sub(t) >= deviceSeenEvery {
			// best effort: a missed stamp is written by the next request
			_, _ = s.DB.Exec(`UPDATE device_tokens SET last_used_at = ?, last_ip = ? WHERE id = ?`,
				now.UTC().Format(time.RFC3339), auth.ClientIP(r), id)
		}
		w.Header().Set("Cache-Control", "no-store")
		next(w, r.WithContext(context.WithValue(r.Context(), tvUserKey{}, &u)))
	})
}

// hasScope reports whether the space-separated scope list holds want.
func hasScope(list, want string) bool {
	for _, s := range strings.Fields(list) {
		if s == want {
			return true
		}
	}
	return false
}
