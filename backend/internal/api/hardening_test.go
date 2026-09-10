package api

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/pquerna/otp/totp"
)

// A TOTP code opens one login: the same code on a second pending token is
// refused while it is still inside its window.
func TestLoginTotpRefusesReplayedCode(t *testing.T) {
	mux, s, token, sec := totpFixture(t)
	code, err := totp.GenerateCode(sec, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rec := postTotp(mux, token, code); rec.Code != http.StatusOK {
		t.Fatalf("first use: %d %s", rec.Code, rec.Body.String())
	}
	token2, _ := s.newLoginPending(1)
	if rec := postTotp(mux, token2, code); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid code") {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
}

// A verification link works for a day and not longer.
func TestVerifyLinkExpires(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.Exec(`INSERT INTO users (id, email, password_hash, email_verified, verify_token, verify_sent_at) VALUES
		(1, 'old@example.com', 'x', 0, 'old', datetime('now', '-25 hours')),
		(2, 'new@example.com', 'x', 0, 'new', datetime('now', '-1 hour'))`)
	s := &Server{DB: d}
	mux := http.NewServeMux()
	s.Register(mux)
	if rec := doReq(mux, "GET", "/api/auth/verify?token=old", "", nil); rec.Header().Get("Location") != "/?verify=invalid" {
		t.Fatalf("stale link accepted: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := doReq(mux, "GET", "/api/auth/verify?token=new", "", nil); rec.Header().Get("Location") != "/?verify=ok" {
		t.Fatalf("fresh link refused: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	var verified int
	d.QueryRow(`SELECT email_verified FROM users WHERE id = 1`).Scan(&verified)
	if verified != 0 {
		t.Fatal("stale link verified the account")
	}
}
