package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/totp"
)

// totpEnabled reports whether the user has a confirmed TOTP secret.
func (s *Server) totpEnabled(userID int64) bool {
	var confirmed sql.NullString
	err := s.DB.QueryRow(`SELECT confirmed_at FROM user_totp WHERE user_id = ?`, userID).Scan(&confirmed)
	return err == nil && confirmed.Valid
}

// newLoginPending mints a short-lived single-use token that bridges a correct
// password and the second-factor step (so the password is never re-sent).
func (s *Server) newLoginPending(userID int64, remember bool) (string, error) {
	token := randToken()
	exp := time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
	s.DB.Exec(`DELETE FROM login_pending WHERE user_id = ? OR expires_at <= ?`, userID, time.Now().UTC().Format(time.RFC3339))
	_, err := s.DB.Exec(`INSERT INTO login_pending (token_hash, user_id, expires_at, remember) VALUES (?, ?, ?, ?)`,
		hashToken(token), userID, exp, remember)
	return token, err
}

// pendingFlags is what the password step left for the second: the "stay
// signed in" choice, and whether the password was one the policy refuses.
func (s *Server) pendingFlags(token string) (remember, weak bool, err error) {
	err = s.DB.QueryRow(`SELECT remember, weak FROM login_pending WHERE token_hash = ?`, hashToken(token)).Scan(&remember, &weak)
	return remember, weak, err
}

// holdForPassword holds the account until it sets a password the policy
// accepts. It takes precedence over a passkey hold, which SetPassword puts
// back while a passkey to replace is left.
func (s *Server) holdForPassword(userID int64) error {
	_, err := s.DB.Exec(`UPDATE users SET auth_upgrade = 'password' WHERE id = ?`, userID)
	return err
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

// TotpSetupResponse carries the enrollment material: the base32 secret and the
// otpauth URL, which the app shows as a QR code.
type TotpSetupResponse struct {
	Secret     string `json:"secret"`
	OtpauthUrl string `json:"otpauthUrl"`
}

// handleTotpSetup starts enrollment: generate a secret (stored unconfirmed) and
// return the otpauth URL + base32 secret for the authenticator app.
// @Summary  Begin TOTP enrollment
// @Description Generates a new TOTP secret (stored unconfirmed) and returns the otpauth URL and base32 secret for the authenticator app.
// @Tags     TwoFactor
// @Accept   json
// @Produce  json
// @Success  200 {object} TotpSetupResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Param    body body reauthRequest true "the account's password"
// @Failure  403 {object} ErrorResponse
// @Router   /api/auth/totp/setup [post]
func (s *Server) handleTotpSetup(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in reauthRequest
	if !readJSON(w, r, &in) || !s.reauth(w, r, u.ID, in.Password) {
		return
	}
	if s.totpEnabled(u.ID) {
		writeErr(w, http.StatusConflict, "TOTP already enabled")
		return
	}
	sec, uri, err := totp.New("WeebSync", u.Email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "totp error")
		return
	}
	enc, err := secret.Encrypt(sec)
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
	writeJSON(w, http.StatusOK, TotpSetupResponse{Secret: sec, OtpauthUrl: uri})
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
	code := normalizeTotpCode(in.Code)
	if !totp.Valid(code, sec, time.Now()) || !s.totpAccept(u.ID, code) {
		writeErr(w, http.StatusBadRequest, "invalid code")
		return
	}
	codes, err := s.confirmTotp(u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not generate recovery codes")
		return
	}
	s.securityNotice(r, u.ID, noticeTotpOn)
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
// @Failure  403 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
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
	// An OIDC account has no password to confirm with, and its TOTP guards
	// nothing: only a password login asks for it. It used to be stuck on.
	if !s.reauth(w, r, u.ID, in.Password) {
		return
	}
	// both or neither: a failed first delete answered "ok" with 2FA still on
	if err := db.Tx(s.DB, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`DELETE FROM user_totp WHERE user_id = ?`, u.ID); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM user_recovery_codes WHERE user_id = ?`, u.ID)
		return err
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not disable TOTP")
		return
	}
	s.securityNotice(r, u.ID, noticeTotpOff)
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
	userID, ok := s.peekLoginPending(in.Token)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	// the code counts against the account like the password does: a fresh
	// pending token per correct password must not reset the guessing
	var email string
	s.DB.QueryRow(`SELECT email FROM users WHERE id = ?`, userID).Scan(&email)
	if wait := s.accountWait(r, email); wait > 0 {
		tooMany(w, wait)
		return
	}
	sec, ok := s.totpSecret(userID)
	code := normalizeTotpCode(in.Code)
	if !ok || (!(totp.Valid(code, sec, time.Now()) && s.totpAccept(userID, code)) && !s.useRecoveryCode(userID, normalizeRecoveryCode(in.Code))) {
		s.failLoginPending(in.Token)
		s.accountFailed(r, email)
		writeErr(w, http.StatusUnauthorized, "invalid code")
		return
	}
	remember, weak, err := s.pendingFlags(in.Token)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "login error")
		return
	}
	if !s.consumeLoginPending(in.Token, userID) {
		writeErr(w, http.StatusUnauthorized, "invalid or expired login")
		return
	}
	if weak && s.holdForPassword(userID) != nil {
		writeErr(w, http.StatusInternalServerError, "login error")
		return
	}
	if err := auth.CreateSession(s.DB, w, r, userID, remember); err != nil {
		writeErr(w, http.StatusInternalServerError, "session error")
		return
	}
	s.accountSignedIn(w, r, email)
	writeJSON(w, http.StatusOK, LoginResponse{ID: userID, Email: email})
}

// normalizeTotpCode drops what people type around the six digits: authenticator
// apps show the code as "146 493", and a pasted one may carry a dash or a
// trailing newline.
func normalizeTotpCode(code string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '-' {
			return -1
		}
		return r
	}, code)
}

// normalizeRecoveryCode brings a typed recovery code to the stored form
// "xxxxx-xxxxx": lower case, no spaces, the dash optional on input.
func normalizeRecoveryCode(code string) string {
	c := strings.ToLower(normalizeTotpCode(code))
	if len(c) == 10 {
		c = c[:5] + "-" + c[5:]
	}
	return c
}

// totpAccept records a valid code as used; false when it is the code the
// user already got in with. A code lives 90 seconds and consecutive steps
// never repeat, so remembering the last one is the whole replay check.
func (s *Server) totpAccept(userID int64, code string) bool {
	res, err := s.DB.Exec(`UPDATE user_totp SET last_code = ? WHERE user_id = ? AND last_code != ?`, code, userID, code)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n == 1
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

// confirmTotp switches the user's TOTP on and replaces the recovery codes with
// 10 fresh ones, returning the plaintext (only chance to see them). One
// transaction: the user must never be shown codes that were not stored, nor
// end up with TOTP on and no way back in.
func (s *Server) confirmTotp(userID int64) ([]string, error) {
	codes := make([]string, 0, 10)
	err := db.Tx(s.DB, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE user_totp SET confirmed_at = datetime('now') WHERE user_id = ?`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM user_recovery_codes WHERE user_id = ?`, userID); err != nil {
			return err
		}
		for i := 0; i < 10; i++ {
			c, err := recoveryCode()
			if err != nil {
				return err
			}
			codes = append(codes, c)
			if _, err := tx.Exec(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)`, userID, hashToken(c)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
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
			res, err := s.DB.Exec(`UPDATE user_recovery_codes SET used_at = datetime('now') WHERE rowid = ? AND used_at IS NULL`, rowid)
			if err != nil {
				return false
			}
			n, _ := res.RowsAffected()
			return n == 1
		}
	}
	return false
}

// codeAlphabet has 31 symbols, so a random byte cannot be reduced modulo its
// length without favouring the first eight.
const codeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// randSymbols draws n symbols of codeAlphabet from src by rejection sampling:
// bytes from 248 up (the incomplete last round of 31) are dropped.
func randSymbols(src io.Reader, n int) ([]byte, error) {
	const limit = 256 / len(codeAlphabet) * len(codeAlphabet)
	out := make([]byte, 0, n)
	buf := make([]byte, n)
	for len(out) < n {
		if _, err := io.ReadFull(src, buf[:n-len(out)]); err != nil {
			return nil, err
		}
		for _, v := range buf[:n-len(out)] {
			if int(v) < limit {
				out = append(out, codeAlphabet[int(v)%len(codeAlphabet)])
			}
		}
	}
	return out, nil
}

// recoveryCode returns a random "xxxxx-xxxxx" code (crockford-ish base32).
func recoveryCode() (string, error) {
	sym, err := randSymbols(rand.Reader, 10)
	if err != nil {
		return "", err
	}
	return string(sym[:5]) + "-" + string(sym[5:]), nil
}
