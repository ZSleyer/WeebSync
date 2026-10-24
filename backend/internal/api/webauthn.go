package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// ── WebAuthn user adapter ────────────────────────────────────────────────────

type waUser struct {
	id     int64
	handle []byte
	email  string
	creds  []webauthn.Credential
}

func (u *waUser) WebAuthnID() []byte                         { return u.handle }
func (u *waUser) WebAuthnName() string                       { return u.email }
func (u *waUser) WebAuthnDisplayName() string                { return u.email }
func (u *waUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// loadWAUser assembles the adapter for a user id, generating the stable handle
// on first use.
func (s *Server) loadWAUser(userID int64) (*waUser, error) {
	u := &waUser{id: userID}
	var handle []byte
	if err := s.DB.QueryRow(`SELECT email, webauthn_handle FROM users WHERE id = ?`, userID).Scan(&u.email, &handle); err != nil {
		return nil, err
	}
	if len(handle) == 0 {
		handle = make([]byte, 32)
		if _, err := rand.Read(handle); err != nil {
			return nil, err
		}
		// a handle that was not stored would bind the new passkey to an id no
		// later login can find
		if _, err := s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID); err != nil {
			return nil, err
		}
	}
	u.handle = handle
	u.creds = s.waCredentials(userID)
	return u, nil
}

func (s *Server) waCredentials(userID int64) []webauthn.Credential {
	rows, err := s.DB.Query(`SELECT cred_json FROM webauthn_credentials WHERE user_id = ?`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []webauthn.Credential
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) != nil {
			continue
		}
		var c webauthn.Credential
		if json.Unmarshal(raw, &c) == nil {
			// the warning is about one ceremony: one stored by an older
			// release must not refuse every later sign-in
			c.Authenticator.CloneWarning = false
			out = append(out, c)
		}
	}
	if rows.Err() != nil {
		return nil
	}
	return out
}

func (s *Server) userByHandle(handle []byte) (*waUser, error) {
	var id int64
	if err := s.DB.QueryRow(`SELECT id FROM users WHERE webauthn_handle = ?`, handle).Scan(&id); err != nil {
		return nil, err
	}
	return s.loadWAUser(id)
}

// errWebAuthnNeedsHost: the instance is reached by an IP address.
var errWebAuthnNeedsHost = errors.New("passkeys need a host name")

// waConfigErr answers a failed webauthnFor: an IP address is the caller's
// setup (409), anything else a fault of ours.
func waConfigErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errWebAuthnNeedsHost) {
		writeErr(w, http.StatusConflict, "passkeys need a host name, not an IP address")
		return
	}
	writeErr(w, http.StatusInternalServerError, "webauthn config error")
}

// webauthnFor builds a WebAuthn instance for this request. RP-ID/origin come from
// the configured base_url (stable), falling back to the request origin.
func (s *Server) webauthnFor(r *http.Request) (*webauthn.WebAuthn, error) {
	origin := s.baseURL()
	if origin == "" {
		origin = requestOrigin(r)
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	// an IP address is no valid relying party ID; the library refuses it too,
	// but with an error that cannot be told from a real fault
	if net.ParseIP(u.Hostname()) != nil {
		return nil, errWebAuthnNeedsHost
	}
	return webauthn.New(&webauthn.Config{
		RPID:          u.Hostname(),
		RPDisplayName: "WeebSync",
		RPOrigins:     []string{origin},
	})
}

// ── ephemeral ceremony store ────────────────────────────────────────────────

type waCeremony struct {
	data *webauthn.SessionData
	exp  time.Time
	// client is the rate-limit key (limitKey) of the address it was made for
	client string
}

// The store is fed without a login (passkey login/begin), so it is bounded:
// at most waMaxCeremonies live at once, the oldest giving way to a new one.
// Every ceremony lives waTTL, so the order they came in is the order they
// expire in: waOrder keeps that order, and expired (or full-store) entries
// leave from its front - no walk over the whole store under the lock, which
// every insert used to do.
const waTTL = 5 * time.Minute

var (
	waMu       sync.Mutex
	waSessions = map[string]waCeremony{}
	// ids in the order they were put; ones already taken are skipped
	waOrder         []string
	waMaxCeremonies = 10000
	// live ceremonies per client: a client at its cap is refused instead of
	// pushing everyone else's ceremonies out of a full store
	waClients      = map[string]int{}
	waMaxPerClient = 32
)

// waDrop removes a stored ceremony and gives its client the turn back.
// Caller holds waMu.
func waDrop(id string) {
	c, ok := waSessions[id]
	if !ok {
		return
	}
	delete(waSessions, id)
	if waClients[c.client]--; waClients[c.client] <= 0 {
		delete(waClients, c.client)
	}
}

// waPut stores a ceremony for client (the limitKey of its address); false
// when that client already holds waMaxPerClient live ones.
func waPut(data *webauthn.SessionData, client string) (string, bool) {
	id := randToken()
	waMu.Lock()
	defer waMu.Unlock()
	now := time.Now()
	for len(waOrder) > 0 {
		c, live := waSessions[waOrder[0]]
		if live && now.Before(c.exp) && len(waSessions) < waMaxCeremonies {
			break
		}
		waDrop(waOrder[0])
		waOrder = waOrder[1:]
	}
	if waClients[client] >= waMaxPerClient {
		return "", false
	}
	// ids of taken ceremonies wait in the queue until they reach its front;
	// should they pile up behind a live one, the queue is rebuilt (rarely)
	if len(waOrder) > 2*waMaxCeremonies {
		live := waOrder[:0:0]
		for _, k := range waOrder {
			if _, ok := waSessions[k]; ok {
				live = append(live, k)
			}
		}
		waOrder = live
	}
	waSessions[id] = waCeremony{data: data, exp: now.Add(waTTL), client: client}
	waClients[client]++
	waOrder = append(waOrder, id)
	return id, true
}

// waStartCeremony stores the ceremony for the request's client and answers with its
// id, or 429 when that client holds too many already.
func waStartCeremony(w http.ResponseWriter, r *http.Request, session *webauthn.SessionData, options any) {
	id, ok := waPut(session, limitKey(auth.ClientIP(r)))
	if !ok {
		tooMany(w, waTTL)
		return
	}
	writeJSON(w, http.StatusOK, WebAuthnBeginResponse{SessionID: id, PublicKey: options})
}

func waTake(id string) *webauthn.SessionData {
	waMu.Lock()
	defer waMu.Unlock()
	c, ok := waSessions[id]
	waDrop(id)
	if !ok || time.Now().After(c.exp) {
		return nil
	}
	return c.data
}

// storeCredential persists a freshly registered credential.
func (s *Server) storeCredential(userID int64, c *webauthn.Credential, name string, passwordless bool) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	pw := 0
	if passwordless {
		pw = 1
	}
	// a passkey was registered with user verification required, so it is
	// known to verify; a new one also replaces the passkey that signed in
	// without, and with that lifts the hold
	return db.Tx(s.DB, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
			VALUES (?, ?, ?, ?, ?, ?)`, userID, c.ID, raw, name, pw, pw); err != nil {
			return err
		}
		if !passwordless {
			return nil
		}
		if _, err := tx.Exec(`DELETE FROM webauthn_credentials WHERE user_id = ? AND replace_due = 1 AND passwordless = 1`, userID); err != nil {
			return err
		}
		return liftPasskeyHold(tx, userID)
	})
}

// liftPasskeyHold ends the passkey hold once no credential is left that
// signed in without verifying the user.
func liftPasskeyHold(tx interface {
	Exec(string, ...any) (sql.Result, error)
}, userID int64) error {
	_, err := tx.Exec(`UPDATE users SET auth_upgrade = '' WHERE id = ? AND auth_upgrade = 'passkey'
		AND NOT EXISTS (SELECT 1 FROM webauthn_credentials WHERE user_id = ? AND replace_due = 1)`, userID, userID)
	return err
}

// reauth checks the password a change to the account's sign-in factors comes
// with (ASVS 7.5.1): a stolen session alone must not add a passkey that
// outlives it, or switch on TOTP and lock the owner out. 403, not 401: the
// session is fine, and a 401 would sign the client out. An account without a
// password signs in through its provider and has nothing to confirm with.
//
// Every check counts like a sign-in: a wrong password spends from the
// account's bucket and the route sits behind the per-address limit, or a
// session (one held for a passkey that verified nobody, say) could guess the
// password at will through a removal that removes nothing.
func (s *Server) reauth(w http.ResponseWriter, r *http.Request, userID int64, password string) bool {
	var hash, email string
	if err := s.DB.QueryRow(`SELECT password_hash, email FROM users WHERE id = ?`, userID).Scan(&hash, &email); err != nil {
		dbErr(w, err)
		return false
	}
	if hash == "" {
		return true
	}
	return s.checkPassword(w, r, email, password, hash, "invalid password")
}

// checkPassword verifies password for a request that already has a session,
// spending an attempt of the account's bucket before the check (as a sign-in
// does) and giving the bucket back when the password was right. Unlike a
// sign-in it does not trust the device cookie: the session may stem from a
// passkey that verified nobody, and its browser must not guess the password
// unbounded. Only a trusted network is exempt.
func (s *Server) checkPassword(w http.ResponseWriter, r *http.Request, email, password, hash, refusal string) bool {
	trusted := s.accountLimiter == nil || s.ipTrusted(auth.ClientIP(r))
	if !trusted {
		if ok, wait := s.accountLimiter.take(accountKey(email)); !ok {
			tooMany(w, max(wait, time.Second))
			return false
		}
	}
	ok, err := auth.VerifyPasswordContext(r.Context(), password, hash)
	if err != nil {
		hashBusy(w)
		return false
	}
	if !ok {
		writeErr(w, http.StatusForbidden, refusal)
		return false
	}
	// whoever knows the password has nothing left to guess, like a sign-in
	if !trusted {
		s.accountLimiter.reset(accountKey(email))
	}
	return true
}

// cloned reports whether the library flagged the assertion's signature
// counter as not advancing past the stored one: a second copy of the key may
// be in use. The library leaves the decision to the relying party; the
// sign-in is refused and the stored counter kept.
func cloned(c *webauthn.Credential, userID int64) bool {
	if !c.Authenticator.CloneWarning {
		return false
	}
	slog.Warn("webauthn sign count did not advance, possibly a cloned authenticator", "user", userID, "count", c.Authenticator.SignCount)
	return true
}

// updateCredential re-saves a credential after a login (sign-count bump).
func (s *Server) updateCredential(c *webauthn.Credential) {
	if raw, err := json.Marshal(c); err == nil {
		// the sign count is what tells a cloned authenticator apart (see cloned)
		if _, err := s.DB.Exec(`UPDATE webauthn_credentials SET cred_json = ?, last_used = datetime('now') WHERE credential_id = ?`, raw, c.ID); err != nil {
			slog.Warn("webauthn sign count not stored", "err", err)
		}
	}
}

func (s *Server) hasSecurityKey(userID int64) (bool, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ? AND passwordless = 0`, userID).Scan(&n)
	return n > 0, err
}

// ── registration ────────────────────────────────────────────────────────────

// WebAuthnBeginResponse carries a ceremony id and the browser-facing publicKey
// options for a registration or assertion ceremony.
type WebAuthnBeginResponse struct {
	SessionID string `json:"sessionId"`
	PublicKey any    `json:"publicKey"`
}

// handleWebAuthnRegisterBegin starts a passkey/security-key registration.
// @Summary  Begin passkey/security-key registration
// @Description Starts a WebAuthn registration ceremony. Send X-WA-Type: key for a cross-platform second-factor security key; otherwise a resident passkey is requested. Returns the ceremony id and credential creation options.
// @Tags     TwoFactor
// @Produce  json
// @Param    X-WA-Type header string false "\"key\" for a second-factor security key; otherwise a passwordless passkey"
// @Param    body body reauthRequest true "the account's password"
// @Success  200 {object} WebAuthnBeginResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Failure  503 {object} ErrorResponse
// @Security CookieAuth
// @Failure  429 {object} ErrorResponse
// @Router   /api/auth/webauthn/register/begin [post]
func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	var in reauthRequest
	if !readJSON(w, r, &in) || !s.reauth(w, r, u.ID, in.Password) {
		return
	}
	user, err := s.loadWAUser(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	passwordless := r.Header.Get("X-WA-Type") != "key"
	// a passkey stands in for the password, so an OIDC-only account has
	// nothing it could stand in for - see handleWebAuthnLoginFinish
	if passwordless && !s.hasPassword(u.ID) {
		writeErr(w, http.StatusForbidden, "passkeys need an account with a password")
		return
	}
	// a passkey is the whole sign-in, so it must verify the user (PIN,
	// fingerprint, face): without, it is one factor standing in for two
	// (NIST 800-63B-4 3.1.7.2)
	sel := protocol.AuthenticatorSelection{UserVerification: protocol.VerificationRequired}
	if passwordless {
		sel.ResidentKey = protocol.ResidentKeyRequirementRequired
	} else {
		sel.AuthenticatorAttachment = protocol.CrossPlatform
		sel.ResidentKey = protocol.ResidentKeyRequirementDiscouraged
		sel.UserVerification = protocol.VerificationDiscouraged
	}
	creation, session, err := wa.BeginRegistration(user, webauthn.WithAuthenticatorSelection(sel))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	waStartCeremony(w, r, session, creation.Response)
}

// waName is the credential's display name from the X-WA-Name header. A header
// carries only bytes, so the client percent-encodes the name; a value that is
// no valid encoding (an older client) is kept as sent, and whatever is not
// UTF-8 is dropped rather than stored.
func waName(r *http.Request) string {
	raw := r.Header.Get("X-WA-Name")
	name, err := url.PathUnescape(raw)
	if err != nil {
		name = raw
	}
	name = strings.ToValidUTF8(name, "")
	if name == "" {
		return "Passkey"
	}
	return name
}

// handleWebAuthnRegisterFinish stores a freshly registered credential.
// @Summary  Finish passkey/security-key registration
// @Description Completes a WebAuthn registration ceremony and stores the new credential. The ceremony id and metadata travel in headers; the request body is the credential attestation.
// @Tags     TwoFactor
// @Produce  json
// @Param    X-WA-Session header string true "ceremony id from register/begin"
// @Param    X-WA-Name header string false "display name for the credential, percent-encoded (UTF-8)"
// @Param    body body object true "WebAuthn attestation"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/webauthn/register/finish [post]
func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	// ceremony id + metadata travel in headers, not the query string, so they
	// don't leak into access/proxy logs or a Referer (the body is the credential)
	session := waTake(r.Header.Get("X-WA-Session"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired registration session")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	user, err := s.loadWAUser(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	cred, err := wa.FinishRegistration(user, *session, r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// go-webauthn parses the key itself only for some attestation formats; a
	// key off the curve would be stored and could never sign in
	if _, err := webauthncose.ParsePublicKey(cred.PublicKey); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid credential public key: "+err.Error())
		return
	}
	name := waName(r)
	// what kind of credential this is was decided at begin, behind the
	// password check, and travels in the ceremony; a header on this request
	// could turn a security key (no user verification) into a passkey
	passwordless := session.UserVerification == protocol.VerificationRequired
	if err := s.storeCredential(u.ID, cred, name, passwordless); err != nil {
		if db.IsUnique(err) {
			writeErr(w, http.StatusConflict, "credential already registered")
			return
		}
		dbErr(w, err)
		return
	}
	if passwordless {
		s.securityNotice(r, u.ID, noticePasskeyAdded)
	} else {
		s.securityNotice(r, u.ID, noticeKeyAdded)
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// ── passwordless login ──────────────────────────────────────────────────────

// handleWebAuthnLoginBegin starts a discoverable passkey login.
// @Summary  Begin passwordless passkey login
// @Description Starts a discoverable WebAuthn login ceremony and returns the ceremony id and assertion options. Disabled while OIDC-only auth is active.
// @Tags     TwoFactor
// @Produce  json
// @Success  200 {object} WebAuthnBeginResponse
// @Failure  403 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Failure  429 {object} ErrorResponse
// @Router   /api/auth/webauthn/login/begin [post]
func (s *Server) handleWebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	assertion, session, err := wa.BeginDiscoverableLogin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	waStartCeremony(w, r, session, assertion.Response)
}

// handleWebAuthnLoginFinish completes a passwordless passkey login.
// @Summary  Finish passwordless passkey login
// @Description Completes a discoverable WebAuthn login ceremony and establishes a session. The ceremony id travels in the X-WA-Session header; the body is the assertion.
// @Tags     TwoFactor
// @Produce  json
// @Param    X-WA-Session header string true "ceremony id from login/begin"
// @Param    body body object true "WebAuthn assertion"
// @Success  200 {object} LoginResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/webauthn/login/finish [post]
func (s *Server) handleWebAuthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	session := waTake(r.Header.Get("X-WA-Session"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired login session")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	var matched *waUser
	handler := func(_, userHandle []byte) (webauthn.User, error) {
		user, err := s.userByHandle(userHandle)
		if err != nil {
			return nil, err
		}
		matched = user
		return user, nil
	}
	parsed, err := protocol.ParseCredentialRequestResponse(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "passkey login failed")
		return
	}
	_, cred, err := wa.ValidatePasskeyLogin(handler, *session, parsed)
	if err != nil || matched == nil || cloned(cred, matched.id) {
		writeErr(w, http.StatusUnauthorized, "passkey login failed")
		return
	}
	// An account without a password exists through OIDC, and the provider
	// decides on every login whether it may still get in (the allowed groups).
	// A passkey on it would be a way in that never asks the provider again.
	if !s.hasPassword(matched.id) {
		writeErr(w, http.StatusForbidden, "this account signs in through OIDC")
		return
	}
	if !s.approved(matched.id) {
		writeErr(w, http.StatusForbidden, "account awaits approval")
		return
	}
	// a security key confirms a password sign-in; on its own it is no way in
	var passwordless int
	if err := s.DB.QueryRow(`SELECT passwordless FROM webauthn_credentials WHERE credential_id = ?`, cred.ID).Scan(&passwordless); err != nil && !errors.Is(err, sql.ErrNoRows) {
		dbErr(w, err)
		return
	}
	if passwordless != 1 {
		writeErr(w, http.StatusUnauthorized, "passkey login failed")
		return
	}
	// what this ceremony did, not the credential's latched flag
	unverified := false
	if parsed.Response.AuthenticatorData.Flags.HasUserVerified() {
		if _, err := s.DB.Exec(`UPDATE webauthn_credentials SET uv_required = 1 WHERE credential_id = ?`, cred.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "login error")
			return
		}
	} else {
		var uvRequired int
		if err := s.DB.QueryRow(`SELECT uv_required FROM webauthn_credentials WHERE credential_id = ?`, cred.ID).Scan(&uvRequired); err != nil {
			writeErr(w, http.StatusInternalServerError, "login error")
			return
		}
		if uvRequired == 1 {
			writeErr(w, http.StatusUnauthorized, "this passkey must verify you with a PIN or biometrics")
			return
		}
		// registered before the rule: in, but only onto the page that asks
		// for a passkey that verifies (auth.Middleware holds the account)
		_, err1 := s.DB.Exec(`UPDATE webauthn_credentials SET replace_due = 1 WHERE credential_id = ?`, cred.ID)
		_, err2 := s.DB.Exec(`UPDATE users SET auth_upgrade = 'passkey' WHERE id = ? AND auth_upgrade = ''`, matched.id)
		if err1 != nil || err2 != nil {
			writeErr(w, http.StatusInternalServerError, "login error")
			return
		}
		unverified = true
	}
	s.updateCredential(cred)
	// the body is the assertion, so the "stay signed in" box rides in a header
	if err := auth.CreateSession(s.DB, w, r, matched.id, r.Header.Get("X-Remember") == "1"); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	// a passkey that verified nobody proves no owner: no reset of the
	// account's failures, no device cookie
	if !unverified {
		s.accountSignedIn(w, r, strings.ToLower(matched.email))
	}
	s.signInAlert(w, r, matched.id, signInPasskey)
	writeJSON(w, http.StatusOK, LoginResponse{ID: matched.id, Email: matched.email})
}

// ── second-factor assertion (security key after password) ───────────────────

// handleWebAuthn2FABegin starts a security-key assertion as a second factor.
// @Summary  Begin security-key second factor
// @Description Starts a WebAuthn assertion for the enrolled security key after a correct password, keyed by the short-lived pending token.
// @Tags     TwoFactor
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"token\":\"...\"}"
// @Success  200 {object} WebAuthnBeginResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Failure  429 {object} ErrorResponse
// @Router   /api/auth/webauthn/2fa/begin [post]
func (s *Server) handleWebAuthn2FABegin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	userID, ok := s.peekLoginPending(in.Token)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	user, err := s.loadWAUser(userID)
	if err != nil {
		dbErr(w, err)
		return
	}
	assertion, session, err := wa.BeginLogin(user)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	waStartCeremony(w, r, session, assertion.Response)
}

// handleWebAuthn2FAFinish completes the security-key second factor.
// @Summary  Finish security-key second factor
// @Description Completes the security-key assertion and establishes a session. The ceremony id and pending token travel in the X-WA-Session and X-WA-Token headers; the body is the assertion.
// @Tags     TwoFactor
// @Produce  json
// @Param    X-WA-Session header string true "ceremony id from 2fa/begin"
// @Param    X-WA-Token header string true "short-lived pending login token"
// @Param    body body object true "WebAuthn assertion"
// @Success  200 {object} LoginResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/webauthn/2fa/finish [post]
func (s *Server) handleWebAuthn2FAFinish(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-WA-Token")
	session := waTake(r.Header.Get("X-WA-Session"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired login session")
		return
	}
	// spent before the assertion is checked, like the TOTP code
	userID, ok := s.reserveLoginPending(token)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		waConfigErr(w, err)
		return
	}
	user, err := s.loadWAUser(userID)
	if err != nil {
		dbErr(w, err)
		return
	}
	if wait := s.accountTake(r, strings.ToLower(user.email)); wait > 0 {
		tooMany(w, wait)
		return
	}
	cred, err := wa.FinishLogin(user, *session, r)
	if err != nil || cloned(cred, userID) {
		writeErr(w, http.StatusUnauthorized, "security key verification failed")
		return
	}
	remember, weak, err := s.pendingFlags(token)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "login error")
		return
	}
	if !s.consumeLoginPending(token, userID) {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	if weak && s.holdForPassword(userID) != nil {
		writeErr(w, http.StatusInternalServerError, "login error")
		return
	}
	s.updateCredential(cred)
	if err := auth.CreateSession(s.DB, w, r, userID, remember); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	s.accountSignedIn(w, r, strings.ToLower(user.email))
	s.signInAlert(w, r, userID, signInKey)
	writeJSON(w, http.StatusOK, LoginResponse{ID: userID, Email: user.email})
}

// ── management ──────────────────────────────────────────────────────────────

// WebAuthnCredential is a registered passkey or security key.
type WebAuthnCredential struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Passwordless bool   `json:"passwordless"`
	CreatedAt    string `json:"createdAt"`
	LastUsed     string `json:"lastUsed"`
	// signed in without verifying the user; to be replaced
	ReplaceDue bool `json:"replaceDue"`
}

// reauthRequest carries the password a change to the sign-in factors is
// confirmed with.
type reauthRequest struct {
	Password string `json:"password"`
}

// handleWebAuthnList lists the current user's registered credentials.
// @Summary  List WebAuthn credentials
// @Description Lists the current user's registered passkeys and security keys.
// @Tags     TwoFactor
// @Produce  json
// @Success  200 {array} WebAuthnCredential
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/webauthn/credentials [get]
func (s *Server) handleWebAuthnList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, name, passwordless, created_at, COALESCE(last_used,''), replace_due
		FROM webauthn_credentials WHERE user_id = ? ORDER BY id`, u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	defer rows.Close()
	list := []WebAuthnCredential{}
	for rows.Next() {
		var c WebAuthnCredential
		var pw, due int
		if err := rows.Scan(&c.ID, &c.Name, &pw, &c.CreatedAt, &c.LastUsed, &due); err != nil {
			dbErr(w, err)
			return
		}
		c.Passwordless = pw == 1
		c.ReplaceDue = due == 1
		list = append(list, c)
	}
	if rows.Err() != nil {
		dbErr(w, rows.Err())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleWebAuthnDelete removes one of the current user's credentials.
// @Summary  Delete a WebAuthn credential
// @Description Removes one of the current user's registered passkeys or security keys.
// @Tags     TwoFactor
// @Produce  json
// @Param    id path int true "Credential ID"
// @Param    body body reauthRequest true "the account's password"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Failure  503 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/webauthn/credentials/{id} [delete]
func (s *Server) handleWebAuthnDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	// removing a way in is confirmed with the password like adding one: a
	// stolen session must not strip the owner's second factor, and the
	// session of a passkey that signed in without verifying must not lift
	// its own hold that way
	var in reauthRequest
	if !readJSON(w, r, &in) || !s.reauth(w, r, u.ID, in.Password) {
		return
	}
	// removing the passkey that signed in without verifying is the other way
	// out of the hold: the account goes on with its password
	removed := false
	if err := db.Tx(s.DB, func(tx *sql.Tx) error {
		res, err := tx.Exec(`DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`, pathID(r), u.ID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		removed = n > 0
		return liftPasskeyHold(tx, u.ID)
	}); err != nil {
		dbErr(w, err)
		return
	}
	if removed {
		s.securityNotice(r, u.ID, noticeCredRemoved)
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// ── login-pending helpers (shared with TOTP) ────────────────────────────────

// peekLoginPending validates a pending token without consuming it (the 2FA begin
// step; consume happens on finish).
func (s *Server) peekLoginPending(token string) (int64, bool) {
	var userID int64
	var exp string
	err := s.DB.QueryRow(`SELECT user_id, expires_at FROM login_pending WHERE token_hash = ?`, hashToken(token)).Scan(&userID, &exp)
	if err != nil {
		return 0, false
	}
	if t, perr := time.Parse(time.RFC3339, exp); perr != nil || time.Now().After(t) {
		return 0, false
	}
	return userID, true
}

func (s *Server) consumeLoginPending(token string, userID int64) bool {
	res, err := s.DB.Exec(`DELETE FROM login_pending
		WHERE token_hash = ? AND user_id = ? AND expires_at > ?`,
		hashToken(token), userID, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return false
	}
	n, err := res.RowsAffected()
	return err == nil && n == 1
}

const loginPendingMaxAttempts = 5

// reserveLoginPending spends one second-factor attempt of a pending login
// before the factor is checked, and returns whose login it is. Counting only
// the failures afterwards let parallel attempts all pass the check before the
// first was counted; the conditional UPDATE hands out at most
// loginPendingMaxAttempts, however many arrive at once. Once they are spent
// (or the token expired) the token is dropped, so the next attempt needs the
// password again.
//
// Fails closed: when the count cannot be written the token goes at once, so a
// database error never hands out attempts the budget did not count.
func (s *Server) reserveLoginPending(token string) (int64, bool) {
	h := hashToken(token)
	var userID int64
	err := s.DB.QueryRow(`UPDATE login_pending SET attempts = attempts + 1
		WHERE token_hash = ? AND attempts < ? AND expires_at > ? RETURNING user_id`,
		h, loginPendingMaxAttempts, time.Now().UTC().Format(time.RFC3339)).Scan(&userID)
	if err == nil {
		return userID, true
	}
	if !errors.Is(err, sql.ErrNoRows) {
		slog.Error("login pending attempt not counted", "err", err)
	}
	if _, derr := s.DB.Exec(`DELETE FROM login_pending WHERE token_hash = ?`, h); derr != nil {
		slog.Error("login pending token not dropped", "err", derr)
	}
	return 0, false
}
