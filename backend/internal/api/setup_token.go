package api

import (
	"crypto/rand"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

// The first-run setup token. A fresh instance (no account yet) makes its
// first account the admin and takes an OIDC configuration from anyone, so on
// the open internet whoever reaches it first would own it. Until the first
// account exists, those steps need a token only the operator can read: the
// server log (or WEEBSYNC_SETUP_TOKEN, for a deployment that sets it up front).

// setupTokenHeader carries the token on the first-run requests.
const setupTokenHeader = "X-Setup-Token"

// ensureSetupToken mints the token when there is no account and logs it.
// Called at startup and again whenever a first-run request finds no token,
// so an instance whose accounts were all removed at runtime is never open.
func (s *Server) ensureSetupToken() string {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.setupToken != "" {
		return s.setupToken
	}
	var users int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil || users > 0 {
		return ""
	}
	tok := strings.TrimSpace(os.Getenv("WEEBSYNC_SETUP_TOKEN"))
	if tok == "" {
		tok = newSetupToken()
		slog.Warn("first-run setup: no account exists yet; enter this token in the setup wizard",
			"setup_token", tok)
	}
	s.setupToken = tok
	return tok
}

// setupTokenOK reports whether r carries the setup token. Compared in
// constant time and without the dashes and case people type around it.
func (s *Server) setupTokenOK(r *http.Request) bool {
	want := s.ensureSetupToken()
	if want == "" {
		return false
	}
	norm := func(v string) string {
		return strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(v)))
	}
	return subtle.ConstantTimeCompare([]byte(norm(r.Header.Get(setupTokenHeader))), []byte(norm(want))) == 1
}

// newSetupToken is 20 characters from an alphabet without look-alikes, in
// groups of four: about 98 bits, easy to copy from a log line.
func newSetupToken() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	b := make([]byte, 20)
	rand.Read(b)
	var out strings.Builder
	for i, v := range b {
		if i > 0 && i%4 == 0 {
			out.WriteByte('-')
		}
		out.WriteByte(alphabet[int(v)%len(alphabet)])
	}
	return out.String()
}
