package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
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
