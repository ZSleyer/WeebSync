package auth

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// backchannelEvent is the member a logout token must carry in its "events"
// claim. Anything else with a valid signature is some other kind of token and
// must not end a session.
const backchannelEvent = "http://schemas.openid.net/event/backchannel-logout"

// BackchannelLogoutHandler ends the sessions that belong to a provider session
// the identity provider says is over (OpenID Connect Back-Channel Logout 1.0).
// Without it a logout at the provider left our own session valid until it
// expired on its own.
//
// The provider calls this, not a browser: no cookie, no CSRF token, a
// form-encoded body. What stands in for authentication is the token's
// signature, which is checked against the provider's keys by the same verifier
// the login flow uses - so only the configured issuer, for our own client id,
// can end anything.
//
// Replay needs no separate guard: the only thing a repeated token can do is
// delete sessions that are already gone.
func (m *Manager) BackchannelLogoutHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	o := m.Get()
	if o == nil {
		http.Error(w, "oidc not configured", http.StatusNotFound)
		return
	}
	raw := r.FormValue("logout_token")
	if raw == "" {
		http.Error(w, "logout_token missing", http.StatusBadRequest)
		return
	}
	// signature, issuer, audience and expiry, exactly as for an ID token
	tok, err := o.verifier.Verify(r.Context(), raw)
	if err != nil {
		http.Error(w, "invalid logout token", http.StatusBadRequest)
		return
	}
	var claims struct {
		SID    string                     `json:"sid"`
		Nonce  string                     `json:"nonce"`
		Events map[string]json.RawMessage `json:"events"`
	}
	if err := tok.Claims(&claims); err != nil {
		http.Error(w, "invalid claims", http.StatusBadRequest)
		return
	}
	if _, ok := claims.Events[backchannelEvent]; !ok {
		http.Error(w, "not a logout token", http.StatusBadRequest)
		return
	}
	// a logout token carrying a nonce is an ID token in disguise; the spec
	// forbids it, and accepting one would let a replayed login end sessions
	if claims.Nonce != "" {
		http.Error(w, "nonce not allowed in a logout token", http.StatusBadRequest)
		return
	}
	if claims.SID == "" && tok.Subject == "" {
		http.Error(w, "logout token names no session", http.StatusBadRequest)
		return
	}

	// sid ends one login, sub ends every login of that user at this provider -
	// which is what a provider means when it sends no sid
	var n int64
	if claims.SID != "" {
		res, err := m.DB.Exec(`DELETE FROM sessions WHERE oidc_sid = ?`, claims.SID)
		if err != nil {
			http.Error(w, "db error", http.StatusInternalServerError)
			return
		}
		n, _ = res.RowsAffected()
	} else {
		res, err := m.DB.Exec(`DELETE FROM sessions WHERE oidc_sub = ?`, tok.Subject)
		if err != nil {
			http.Error(w, "db error", http.StatusInternalServerError)
			return
		}
		n, _ = res.RowsAffected()
	}
	slog.Info("oidc back-channel logout", "sessions", n, "bySid", claims.SID != "")
	w.WriteHeader(http.StatusOK)
}
