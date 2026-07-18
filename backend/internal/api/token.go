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

// tokenResponse carries the raw machine token, returned exactly once on create.
type tokenResponse struct {
	Token string `json:"token"`
}

// handleTokenCreate mints the single machine token (e.g. for Home Assistant).
// Only the sha256 is stored; the raw token is returned exactly once.
//
// @Summary      Create machine API token
// @Description  Mints the single machine API token (e.g. for Home Assistant), admin only. Only the hash is stored; the raw token is returned exactly once.
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  tokenResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/token [post]
func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeErr(w, http.StatusInternalServerError, "rng error")
		return
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	if err := db.SetSetting(s.DB, "api_token_hash", hex.EncodeToString(sum[:])); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{Token: token})
}

// handleTokenDelete revokes the machine API token.
//
// @Summary      Delete machine API token
// @Description  Revokes the single machine API token (admin only).
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  OkResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/token [delete]
func (s *Server) handleTokenDelete(w http.ResponseWriter, r *http.Request) {
	if err := db.SetSetting(s.DB, "api_token_hash", ""); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
