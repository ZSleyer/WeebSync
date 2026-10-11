package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
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

func TestPasswordChange(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)

	// an OIDC account has none to change
	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"","new":"longenough123"}`, userC); rec.Code != http.StatusForbidden {
		t.Fatalf("oidc account: got %d, want 403: %s", rec.Code, rec.Body)
	}

	setPassword(t, s, userID, "oldpassword1")
	// a second session elsewhere, which the change has to end
	if err := auth.CreateSession(s.DB, httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), userID); err != nil {
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
