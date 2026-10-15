package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/mailer"
	"github.com/ch4d1/weebsync/internal/secret"
)

// A device cookie spares its browser the account's sign-in limit, but not the
// limit on password checks made from inside a session: those count always.
func TestDeviceCookieDoesNotSpareReauth(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, userC, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "longenough123")
	s.authLimiter.trusted = nil
	device, _ := s.deviceValue("user@example.com", time.Now())
	codes := []int{}
	for i := 0; i < 12; i++ {
		s.authLimiter.resetAll()
		req := httptest.NewRequest("DELETE", "/api/auth/webauthn/credentials/999", strings.NewReader(`{"password":"guess"}`))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(userC)
		req.AddCookie(&http.Cookie{Name: deviceCookie, Value: device})
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		codes = append(codes, rec.Code)
	}
	if codes[len(codes)-1] != http.StatusTooManyRequests {
		t.Errorf("guesses with a device cookie were not limited: %v", codes)
	}
}

// An unverified account answers the same to a right and a wrong password;
// only the right one gets a fresh link.
func TestUnverifiedAccountIsNoPasswordOracle(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	setPassword(t, s, userID, "longenough123")
	s.DB.Exec(`UPDATE users SET email_verified = 0 WHERE id = ?`, userID)
	right := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"longenough123"}`, nil)
	wrong := doReq(mux, "POST", "/api/auth/login", `{"email":"user@example.com","password":"not the password"}`, nil)
	if right.Code != wrong.Code || right.Body.String() != wrong.Body.String() {
		t.Errorf("right %d %s, wrong %d %s", right.Code, right.Body, wrong.Code, wrong.Body)
	}
}

// A setup code from the environment of one repeated character is no code.
func TestTrivialEnvSetupTokenIgnored(t *testing.T) {
	t.Setenv("WEEBSYNC_SETUP_TOKEN", "aaaaaaaaaaaaaaaaaaaaaaaa")
	s := &Server{DB: dbtest.Open(t)}
	if tok := s.ensureSetupToken(); tok == "aaaaaaaaaaaaaaaaaaaaaaaa" || tok == "" {
		t.Errorf("trivial env token taken or none minted: %q", tok)
	}
}
