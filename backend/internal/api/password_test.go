package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
)

func setPassword(t *testing.T, s *Server, id int64, pw string) {
	t.Helper()
	hash, _ := auth.HashPassword(pw)
	if _, err := s.DB.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, id); err != nil {
		t.Fatal(err)
	}
}

func sessionsOf(t *testing.T, s *Server, id int64) int {
	t.Helper()
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, id).Scan(&n)
	return n
}

// Every route that runs argon2id answers 503 when it cannot get a hashing
// slot, instead of running unbounded (64 MiB each) or queueing past the
// request. A request that has already ended stands in for a full gate: the
// gate refuses it before taking a slot. Known and unknown addresses answer
// alike, so the busy answer is no account oracle.
func TestPasswordRoutesAnswerBusy(t *testing.T) {
	mux, s, adminC, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "oldpassword1")
	s.DB.Exec(`UPDATE users SET reset_token_hash = ?, reset_sent_at = datetime('now') WHERE id = ?`, resetHash("tok"), userID)
	db.SetSetting(s.DB, "registration_disabled", "false")
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		method, path, body string
		c                  *http.Cookie
	}{
		{"POST", "/api/auth/login", `{"email":"user@example.com","password":"guess-guess"}`, nil},
		{"POST", "/api/auth/login", `{"email":"nobody@example.com","password":"guess-guess"}`, nil},
		{"POST", "/api/auth/reset", `{"token":"tok","password":"newpassword1"}`, nil},
		{"PUT", "/api/auth/password", `{"current":"oldpassword1","new":"newpassword1"}`, userC},
		{"PUT", "/api/users/" + strconv.FormatInt(userID, 10) + "/password", `{"password":"newpassword1"}`, adminC},
		{"POST", "/api/users", `{"email":"new@example.com","password":"newpassword1"}`, adminC},
		{"POST", "/api/auth/register", `{"email":"other@example.com","password":"newpassword1"}`, nil},
	} {
		s.authLimiter.resetAll()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)).WithContext(gone)
		req.Header.Set("Content-Type", "application/json")
		if tc.c != nil {
			req.AddCookie(tc.c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
			t.Errorf("%s %s with no hashing slot: %d %s", tc.method, tc.path, rec.Code, rec.Body)
		}
	}
	// nothing was changed by the refused requests
	s.authLimiter.resetAll()
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"oldpassword1"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("login with the unchanged password: %d %s", rec.Code, rec.Body)
	}
}

func TestPasswordChange(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)

	// an OIDC account has none to change
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"","new":"longenough123"}`, userC); rec.Code != http.StatusForbidden {
		t.Fatalf("oidc account: got %d, want 403: %s", rec.Code, rec.Body)
	}

	setPassword(t, s, userID, "oldpassword1")
	// a second session elsewhere, which the change has to end
	if err := auth.CreateSession(s.DB, httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), userID, true); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"wrong","new":"longenough123"}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("wrong current: got %d, want 403", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"oldpassword1","new":"short"}`, userC); rec.Code != http.StatusBadRequest {
		t.Errorf("weak new: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"oldpassword1","new":"newpassword1"}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("change: got %d, want 200: %s", rec.Code, rec.Body)
	}
	if n := sessionsOf(t, s, userID); n != 1 {
		t.Errorf("sessions after the change: %d, want only the caller's", n)
	}
	if rec := doReq(mux, "GET", "/api/auth/me", "", userC); rec.Code != http.StatusOK {
		t.Errorf("the caller's own session ended: %d", rec.Code)
	}
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"newpassword1"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("login with the new password: %d %s", rec.Code, rec.Body)
	}
}

// A password the policy refuses still opens the account, but onto nothing
// except the change; the new one lifts the hold.
func TestWeakPasswordHoldsAccount(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "1234567890") // on the breach list

	rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"1234567890"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: got %d: %s", rec.Code, rec.Body)
	}
	c := rec.Result().Cookies()[0]
	if rec := doReq(mux, "GET", "/api/auth/me", "", c); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"upgradeRequired":"password"`) {
		t.Fatalf("me: got %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/servers", "", c); rec.Code != http.StatusForbidden {
		t.Errorf("held account reached the app: %d", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"1234567890","new":"qwertyuiop"}`, c); rec.Code != http.StatusBadRequest {
		t.Errorf("another listed password: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"1234567890","new":"a much better phrase"}`, c); rec.Code != http.StatusOK {
		t.Fatalf("change: got %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/servers", "", c); rec.Code != http.StatusOK {
		t.Errorf("hold not lifted: %d %s", rec.Code, rec.Body)
	}
}

func TestUserPasswordByAdmin(t *testing.T) {
	mux, s, adminC, userC, _, userID := setupUsersTest(t)

	if rec := doReq(mux, "PUT", "/api/users/1/password", `{"password":"longenough123"}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin: got %d, want 403", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/users/999/password", `{"password":"longenough123"}`, adminC); rec.Code != http.StatusNotFound {
		t.Errorf("unknown user: got %d, want 404", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/users/"+strconv.FormatInt(userID, 10)+"/password", `{"password":"longenough123"}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("admin reset: got %d, want 200: %s", rec.Code, rec.Body)
	}
	if n := sessionsOf(t, s, userID); n != 0 {
		t.Errorf("the account's sessions survived the reset: %d", n)
	}
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"longenough123"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("login with the set password: %d %s", rec.Code, rec.Body)
	}
}

// A reset link works once, within its hour, and only with a strong password;
// asking for one answers the same for an unknown address.
func TestPasswordResetByMail(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)

	if rec := doReq(mux, "POST", "/api/auth/forgot", `{"email":"user@example.com"}`, nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("forgot without SMTP: got %d, want 503", rec.Code)
	}
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	db.SetSetting(s.DB, "smtp_port", "1")
	db.SetSetting(s.DB, "base_url", "https://example.com")
	setPassword(t, s, userID, "oldpassword1")

	for _, email := range []string{"user@example.com", "nobody@example.com"} {
		if rec := doReq(mux, "POST", "/api/auth/forgot", `{"email":"`+email+`"}`, nil); rec.Code != http.StatusOK {
			t.Errorf("forgot %s: got %d, want 200", email, rec.Code)
		}
	}
	var stored string
	s.DB.QueryRow(`SELECT reset_token_hash FROM users WHERE id = ?`, userID).Scan(&stored)
	if stored == "" {
		t.Fatal("no reset token stored for the account")
	}

	s.authLimiter.resetAll() // the per-IP limiter would answer 429 before the handler
	// the mailed token is not readable back, so plant a known one
	s.DB.Exec(`UPDATE users SET reset_token_hash = ?, reset_sent_at = datetime('now', '-2 hours') WHERE id = ?`, resetHash("tok"), userID)
	if rec := doReq(mux, "POST", "/api/auth/reset", `{"token":"tok","password":"newpassword1"}`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("expired link: got %d, want 400", rec.Code)
	}
	s.DB.Exec(`UPDATE users SET reset_sent_at = datetime('now') WHERE id = ?`, userID)
	if rec := doReq(mux, "POST", "/api/auth/reset", `{"token":"tok","password":"short"}`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("weak password: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "POST", "/api/auth/reset", `{"token":"tok","password":"newpassword1"}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("reset: got %d, want 200: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/auth/reset", `{"token":"tok","password":"newpassword2"}`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("second use of the link: got %d, want 400", rec.Code)
	}
	if rec := doReq(mux, "GET", "/api/auth/me", "", userC); rec.Code != http.StatusUnauthorized {
		t.Errorf("an old session survived the reset: %d", rec.Code)
	}
	s.authLimiter.resetAll()
	if rec := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"newpassword1"}`, nil); rec.Code != http.StatusOK {
		t.Errorf("login with the new password: %d %s", rec.Code, rec.Body)
	}
}

// Verification is only asked for while a mail server can deliver the link;
// without one the login used to say "check your inbox" for a mail that could
// never come.
func TestUnverifiedLoginFollowsMail(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)
	setPassword(t, s, userID, "longenough123")
	login := `{"email":"user@example.com","password":"longenough123"}`

	if rec := doReq(mux, "POST", "/api/auth/login", login, nil); rec.Code != http.StatusOK {
		t.Errorf("unverified, no mail server: got %d, want 200: %s", rec.Code, rec.Body)
	}
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	if rec := doReq(mux, "POST", "/api/auth/login", login, nil); rec.Code != http.StatusForbidden {
		t.Errorf("unverified, mail server set: got %d, want 403", rec.Code)
	}
	// no base URL: no link can be built, so no send is stamped either
	var sent string
	s.DB.QueryRow(`SELECT verify_sent_at FROM users WHERE id = ?`, userID).Scan(&sent)
	if sent != "" {
		t.Errorf("verify_sent_at = %q without a base URL", sent)
	}
}
