package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/ch4d1/weebsync/internal/db"
)

type machineCtxKey struct{}

// bearerOr serves next with machine scope when a valid API token is presented
// (Authorization: Bearer <token>); otherwise it falls through to the
// session-authenticated handler. Bearer requests carry no cookie, so this
// path is CSRF-immune by construction; the cookie path stays untouched.
func (s *Server) bearerOr(session, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			session.ServeHTTP(w, r)
			return
		}
		stored := db.Setting(s.DB, "api_token_hash")
		sum := sha256.Sum256([]byte(tok))
		if stored == "" || subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(stored)) != 1 {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), machineCtxKey{}, true)))
	})
}

func isMachine(ctx context.Context) bool {
	v, _ := ctx.Value(machineCtxKey{}).(bool)
	return v
}

// handleTokenCreate mints the single machine token (e.g. for Home Assistant).
// Only the sha256 is stored; the raw token is returned exactly once.
func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeErr(w, http.StatusInternalServerError, "rng error")
		return
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	if err := db.SetSetting(s.DB, "api_token_hash", hex.EncodeToString(sum[:])); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (s *Server) handleTokenDelete(w http.ResponseWriter, r *http.Request) {
	if err := db.SetSetting(s.DB, "api_token_hash", ""); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
