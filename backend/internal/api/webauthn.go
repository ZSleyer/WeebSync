package api

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/ch4d1/weebsync/internal/auth"
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
		rand.Read(handle)
		s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID)
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
			out = append(out, c)
		}
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
}

var (
	waMu       sync.Mutex
	waSessions = map[string]waCeremony{}
)

func waPut(data *webauthn.SessionData) string {
	id := randToken()
	waMu.Lock()
	defer waMu.Unlock()
	// opportunistic sweep of expired entries
	now := time.Now()
	for k, v := range waSessions {
		if now.After(v.exp) {
			delete(waSessions, k)
		}
	}
	waSessions[id] = waCeremony{data: data, exp: now.Add(5 * time.Minute)}
	return id
}

func waTake(id string) *webauthn.SessionData {
	waMu.Lock()
	defer waMu.Unlock()
	c, ok := waSessions[id]
	delete(waSessions, id)
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
	_, err = s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless)
		VALUES (?, ?, ?, ?, ?)`, userID, c.ID, raw, name, pw)
	return err
}

// updateCredential re-saves a credential after a login (sign-count bump).
func (s *Server) updateCredential(c *webauthn.Credential) {
	if raw, err := json.Marshal(c); err == nil {
		s.DB.Exec(`UPDATE webauthn_credentials SET cred_json = ?, last_used = datetime('now') WHERE credential_id = ?`, raw, c.ID)
	}
}

func (s *Server) hasSecurityKey(userID int64) bool {
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ? AND passwordless = 0`, userID).Scan(&n)
	return n > 0
}

// ── registration ────────────────────────────────────────────────────────────

func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	wa, err := s.webauthnFor(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
		return
	}
	user, err := s.loadWAUser(u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	passwordless := r.URL.Query().Get("type") != "key"
	sel := protocol.AuthenticatorSelection{UserVerification: protocol.VerificationPreferred}
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
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": waPut(session), "publicKey": creation.Response})
}

func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	session := waTake(r.URL.Query().Get("s"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired registration session")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
		return
	}
	user, err := s.loadWAUser(u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	cred, err := wa.FinishRegistration(user, *session, r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "Passkey"
	}
	if err := s.storeCredential(u.ID, cred, name, r.URL.Query().Get("type") != "key"); err != nil {
		writeErr(w, http.StatusConflict, "credential already registered")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ── passwordless login ──────────────────────────────────────────────────────

func (s *Server) handleWebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
		return
	}
	assertion, session, err := wa.BeginDiscoverableLogin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": waPut(session), "publicKey": assertion.Response})
}

func (s *Server) handleWebAuthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	session := waTake(r.URL.Query().Get("s"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired login session")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
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
	_, cred, err := wa.FinishPasskeyLogin(handler, *session, r)
	if err != nil || matched == nil {
		writeErr(w, http.StatusUnauthorized, "passkey login failed")
		return
	}
	s.updateCredential(cred)
	if err := auth.CreateSession(s.DB, w, r, matched.id); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": matched.id, "email": matched.email})
}

// ── second-factor assertion (security key after password) ───────────────────

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
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
		return
	}
	user, err := s.loadWAUser(userID)
	if err != nil {
		dbErr(w)
		return
	}
	assertion, session, err := wa.BeginLogin(user)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": waPut(session), "publicKey": assertion.Response})
}

func (s *Server) handleWebAuthn2FAFinish(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	session := waTake(r.URL.Query().Get("s"))
	if session == nil {
		writeErr(w, http.StatusBadRequest, "expired login session")
		return
	}
	userID, ok := s.consumeLoginPending(token)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	wa, err := s.webauthnFor(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webauthn config error")
		return
	}
	user, err := s.loadWAUser(userID)
	if err != nil {
		dbErr(w)
		return
	}
	cred, err := wa.FinishLogin(user, *session, r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "security key verification failed")
		return
	}
	s.updateCredential(cred)
	if err := auth.CreateSession(s.DB, w, r, userID); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": userID, "email": user.email})
}

// ── management ──────────────────────────────────────────────────────────────

func (s *Server) handleWebAuthnList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, name, passwordless, created_at, COALESCE(last_used,'')
		FROM webauthn_credentials WHERE user_id = ? ORDER BY id`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	type cred struct {
		ID           int64  `json:"id"`
		Name         string `json:"name"`
		Passwordless bool   `json:"passwordless"`
		CreatedAt    string `json:"createdAt"`
		LastUsed     string `json:"lastUsed"`
	}
	list := []cred{}
	for rows.Next() {
		var c cred
		var pw int
		rows.Scan(&c.ID, &c.Name, &pw, &c.CreatedAt, &c.LastUsed)
		c.Passwordless = pw == 1
		list = append(list, c)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleWebAuthnDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	s.DB.Exec(`DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`, pathID(r), u.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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

func (s *Server) consumeLoginPending(token string) (int64, bool) {
	id, ok := s.peekLoginPending(token)
	if ok {
		s.DB.Exec(`DELETE FROM login_pending WHERE token_hash = ?`, hashToken(token))
	}
	return id, ok
}
