package api

import (
	"crypto/rand"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
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
	// a short or empty code (a lone "-" normalises to nothing) guards nothing
	if tok != "" && (len(normSetupToken(tok)) < 16 || distinctRunes(normSetupToken(tok)) < 8) {
		slog.Warn("WEEBSYNC_SETUP_TOKEN needs at least 16 characters, 8 of them different; it is ignored and a random code is logged instead")
		tok = ""
	}
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
	got := normSetupToken(r.Header.Get(setupTokenHeader))
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(normSetupToken(want))) == 1
}

func normSetupToken(v string) string {
	return strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(v)))
}

// handleSetupOIDCStart trades the setup code for the proof the provider's
// callback needs before it makes the first identity the admin.
//
// @Summary      Start the first OIDC sign-in
// @Description  While no account exists: checks the setup code (X-Setup-Token) and sets a short-lived signed cookie that lets the provider's callback create the first account. Afterwards refused.
// @Tags         Auth
// @Produce      json
// @Success      200  {object}  OkResponse
// @Failure      403  {object}  ErrorResponse
// @Router       /api/auth/setup/oidc-start [post]
func (s *Server) handleSetupOIDCStart(w http.ResponseWriter, r *http.Request) {
	var users int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		dbErr(w)
		return
	}
	if users > 0 {
		writeErr(w, http.StatusForbidden, "setup already completed")
		return
	}
	if !s.setupTokenOK(r) {
		writeErr(w, http.StatusForbidden, "setup token required")
		return
	}
	if err := auth.SetSetupProof(w, r); err != nil {
		writeErr(w, http.StatusInternalServerError, "setup error")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// newSetupToken is 20 characters from an alphabet without look-alikes, in
// groups of four: about 98 bits, easy to copy from a log line.
func newSetupToken() string {
	sym, err := randSymbols(rand.Reader, 20)
	if err != nil {
		panic("setup token: " + err.Error())
	}
	var out strings.Builder
	for i, c := range sym {
		if i > 0 && i%4 == 0 {
			out.WriteByte('-')
		}
		out.WriteByte(c)
	}
	return out.String()
}

func distinctRunes(v string) int {
	seen := map[rune]bool{}
	for _, r := range v {
		seen[r] = true
	}
	return len(seen)
}
