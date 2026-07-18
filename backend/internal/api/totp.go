package api

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"image/png"
	"net/http"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/secret"
)

// totpEnabled reports whether the user has a confirmed TOTP secret.
func (s *Server) totpEnabled(userID int64) bool {
	var confirmed sql.NullString
	err := s.DB.QueryRow(`SELECT confirmed_at FROM user_totp WHERE user_id = ?`, userID).Scan(&confirmed)
	return err == nil && confirmed.Valid
}

// newLoginPending mints a short-lived single-use token that bridges a correct
// password and the second-factor step (so the password is never re-sent).
func (s *Server) newLoginPending(userID int64) (string, error) {
	token := randToken()
	exp := time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
	_, err := s.DB.Exec(`INSERT INTO login_pending (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), userID, exp)
	return token, err
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// TwoFactorStatusResponse reports whether a second factor is enabled.
type TwoFactorStatusResponse struct {
	Enabled bool `json:"enabled"`
}

// handleTotpStatus reports whether the current user has TOTP enabled.
// @Summary  TOTP status
// @Description Reports whether the current user has TOTP enabled.
// @Tags     TwoFactor
// @Produce  json
// @Success  200 {object} TwoFactorStatusResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/totp [get]
func (s *Server) handleTotpStatus(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	writeJSON(w, http.StatusOK, TwoFactorStatusResponse{Enabled: s.totpEnabled(u.ID)})
}

// TotpSetupResponse carries the enrollment material: base32 secret, otpauth URL
// and (best-effort) a data-URI QR image.
type TotpSetupResponse struct {
	Secret     string `json:"secret"`
	OtpauthUrl string `json:"otpauthUrl"`
	Qr         string `json:"qr,omitempty"`
}

// handleTotpSetup starts enrollment: generate a secret (stored unconfirmed) and
// return the otpauth URL + base32 secret for the authenticator app.
// @Summary  Begin TOTP enrollment
// @Description Generates a new TOTP secret (stored unconfirmed) and returns the otpauth URL, base32 secret and a data-URI QR image for the authenticator app.
// @Tags     TwoFactor
// @Produce  json
// @Success  200 {object} TotpSetupResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/totp/setup [post]
func (s *Server) handleTotpSetup(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if s.totpEnabled(u.ID) {
		writeErr(w, http.StatusConflict, "TOTP already enabled")
		return
	}
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "WeebSync", AccountName: u.Email})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "totp error")
		return
	}
	enc, err := secret.Encrypt(key.Secret())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt error")
		return
	}
	// upsert as unconfirmed (a re-run replaces a half-finished setup)
	if _, err := s.DB.Exec(`INSERT INTO user_totp (user_id, secret_enc, confirmed_at) VALUES (?, ?, NULL)
		ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed_at = NULL`,
		u.ID, enc); err != nil {
		dbErr(w)
		return
	}
	resp := TotpSetupResponse{Secret: key.Secret(), OtpauthUrl: key.URL()}
	// render the QR server-side (via boombuler/barcode that pquerna already
	// pulls in) so the frontend needs no QR dependency
	if img, ierr := key.Image(220, 220); ierr == nil {
		var buf bytes.Buffer
		if png.Encode(&buf, img) == nil {
			resp.Qr = "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// RecoveryCodesResponse carries freshly generated one-time recovery codes.
type RecoveryCodesResponse struct {
	RecoveryCodes []string `json:"recoveryCodes"`
}

// handleTotpConfirm verifies the first code, activates TOTP, and returns 10
// one-time recovery codes (shown once).
// @Summary  Confirm TOTP enrollment
// @Description Verifies the first TOTP code, activates TOTP and returns 10 one-time recovery codes (shown once).
// @Tags     TwoFactor
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"code\":\"123456\"}"
// @Success  200 {object} RecoveryCodesResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/totp/confirm [post]
func (s *Server) handleTotpConfirm(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Code string `json:"code"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	sec, ok := s.totpSecret(u.ID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "no TOTP setup in progress")
		return
	}
	if !totp.Validate(in.Code, sec) {
		writeErr(w, http.StatusBadRequest, "invalid code")
		return
	}
	s.DB.Exec(`UPDATE user_totp SET confirmed_at = datetime('now') WHERE user_id = ?`, u.ID)
	codes, err := s.regenRecoveryCodes(u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not generate recovery codes")
		return
	}
	writeJSON(w, http.StatusOK, RecoveryCodesResponse{RecoveryCodes: codes})
}

// handleTotpDisable turns off TOTP after a password re-check.
// @Summary  Disable TOTP
// @Description Turns off TOTP (and clears recovery codes) after a password re-check.
// @Tags     TwoFactor
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"password\":\"...\"}"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/auth/totp [delete]
func (s *Server) handleTotpDisable(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	var hash string
	s.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, u.ID).Scan(&hash)
	if hash == "" || !auth.VerifyPassword(in.Password, hash) {
		writeErr(w, http.StatusUnauthorized, "invalid password")
		return
	}
	s.DB.Exec(`DELETE FROM user_totp WHERE user_id = ?`, u.ID)
	s.DB.Exec(`DELETE FROM user_recovery_codes WHERE user_id = ?`, u.ID)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleLoginTotp completes a password login by verifying the second factor.
// @Summary  Complete login with TOTP
// @Description Completes a password login by verifying the TOTP code (or a recovery code) against the short-lived pending token.
// @Tags     TwoFactor
// @Accept   json
// @Produce  json
// @Param    body body object true "{\"token\":\"...\",\"code\":\"123456\"}"
// @Success  200 {object} LoginResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Router   /api/auth/login/totp [post]
func (s *Server) handleLoginTotp(w http.ResponseWriter, r *http.Request) {
	if s.passwordAuthBlocked() {
		writeErr(w, http.StatusForbidden, "password auth is disabled, use OIDC")
		return
	}
	var in struct {
		Token string `json:"token"`
		Code  string `json:"code"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	// consume the pending token single-use, and only if unexpired
	var userID int64
	var exp string
	err := s.DB.QueryRow(`SELECT user_id, expires_at FROM login_pending WHERE token_hash = ?`, hashToken(in.Token)).Scan(&userID, &exp)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	s.DB.Exec(`DELETE FROM login_pending WHERE token_hash = ?`, hashToken(in.Token))
	if t, perr := time.Parse(time.RFC3339, exp); perr != nil || time.Now().After(t) {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	sec, ok := s.totpSecret(userID)
	if !ok || (!totp.Validate(in.Code, sec) && !s.useRecoveryCode(userID, in.Code)) {
		writeErr(w, http.StatusUnauthorized, "invalid code")
		return
	}
	if err := auth.CreateSession(s.DB, w, r, userID); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	var email string
	s.DB.QueryRow(`SELECT email FROM users WHERE id = ?`, userID).Scan(&email)
	writeJSON(w, http.StatusOK, LoginResponse{ID: userID, Email: email})
}

// totpSecret decrypts the user's stored TOTP secret.
func (s *Server) totpSecret(userID int64) (string, bool) {
	var enc []byte
	if err := s.DB.QueryRow(`SELECT secret_enc FROM user_totp WHERE user_id = ?`, userID).Scan(&enc); err != nil {
		return "", false
	}
	sec, err := secret.Decrypt(enc)
	if err != nil {
		return "", false
	}
	return sec, true
}

// regenRecoveryCodes replaces the user's recovery codes with 10 fresh ones and
// returns the plaintext (only chance to see them).
func (s *Server) regenRecoveryCodes(userID int64) ([]string, error) {
	s.DB.Exec(`DELETE FROM user_recovery_codes WHERE user_id = ?`, userID)
	codes := make([]string, 0, 10)
	for i := 0; i < 10; i++ {
		c, err := recoveryCode()
		if err != nil {
			return nil, err
		}
		codes = append(codes, c)
		s.DB.Exec(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)`, userID, hashToken(c))
	}
	return codes, nil
}

// useRecoveryCode redeems an unused recovery code (constant-time compare against
// each stored hash), marking it used. Reports whether one matched.
func (s *Server) useRecoveryCode(userID int64, code string) bool {
	want := hashToken(code)
	rows, err := s.DB.Query(`SELECT rowid, code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL`, userID)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var rowid int64
		var h string
		if rows.Scan(&rowid, &h) != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			s.DB.Exec(`UPDATE user_recovery_codes SET used_at = datetime('now') WHERE rowid = ?`, rowid)
			return true
		}
	}
	return false
}

// recoveryCode returns a random "xxxxx-xxxxx" code (crockford-ish base32).
func recoveryCode() (string, error) {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 0, 11)
	for i, v := range b {
		if i == 5 {
			out = append(out, '-')
		}
		out = append(out, alphabet[int(v)%len(alphabet)])
	}
	return string(out), nil
}
