package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/pquerna/otp/totp"
)

func TestLoginPendingIsConsumedOnce(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	token, err := s.newLoginPending(1)
	if err != nil {
		t.Fatal(err)
	}
	if !s.consumeLoginPending(token, 1) {
		t.Fatal("valid pending login was rejected")
	}
	if s.consumeLoginPending(token, 1) {
		t.Fatal("pending login was consumed twice")
	}
}

func TestLoginPendingDropsAfterMaxFailures(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	token, err := s.newLoginPending(1)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < loginPendingMaxAttempts; i++ {
		s.failLoginPending(token)
		if _, ok := s.peekLoginPending(token); !ok {
			t.Fatalf("token dropped after %d failures", i)
		}
	}
	s.failLoginPending(token)
	if _, ok := s.peekLoginPending(token); ok {
		t.Fatal("token survived the attempt budget")
	}
	if s.consumeLoginPending(token, 1) {
		t.Fatal("dropped token was consumed")
	}
}

// totpFixture: a confirmed TOTP user with a fresh pending login, wired to the
// real mux so the handler path (limiter, JSON, session) is exercised.
func totpFixture(t *testing.T) (*http.ServeMux, *Server, string, string) {
	t.Helper()
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash, email_verified) VALUES (1, 'a@example.com', 'x', 1)`); err != nil {
		t.Fatal(err)
	}
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "test", AccountName: "a@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	enc, err := secret.Encrypt(key.Secret())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO user_totp (user_id, secret_enc, confirmed_at) VALUES (1, ?, datetime('now'))`, enc); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	mux := http.NewServeMux()
	s.Register(mux)
	token, err := s.newLoginPending(1)
	if err != nil {
		t.Fatal(err)
	}
	return mux, s, token, key.Secret()
}

func postTotp(mux *http.ServeMux, token, code string) *httptest.ResponseRecorder {
	return doReq(mux, "POST", "/api/auth/login/totp", fmt.Sprintf(`{"token":%q,"code":%q}`, token, code), nil)
}

func TestLoginTotpLocksTokenAfterWrongCodes(t *testing.T) {
	mux, s, token, sec := totpFixture(t)
	for i := 0; i < loginPendingMaxAttempts; i++ {
		if rec := postTotp(mux, token, "000000"); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid code") {
			t.Fatalf("attempt %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	s.authLimiter.resetAll() // the per-IP limiter would answer 429 before the handler
	code, err := totp.GenerateCode(sec, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rec := postTotp(mux, token, code); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "expired login") {
		t.Fatalf("valid code after lockout: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRecoveryCodeRedeemsOnce(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	codes, err := s.regenRecoveryCodes(1)
	if err != nil || len(codes) != 10 {
		t.Fatalf("codes=%d err=%v", len(codes), err)
	}
	if !s.useRecoveryCode(1, codes[0]) {
		t.Fatal("fresh code rejected")
	}
	if s.useRecoveryCode(1, codes[0]) {
		t.Fatal("code redeemed twice")
	}
	if !s.useRecoveryCode(1, codes[1]) || s.useRecoveryCode(1, "nope") {
		t.Fatal("second code or garbage misjudged")
	}
}

func TestLoginTotpAcceptsRecoveryCodeOnce(t *testing.T) {
	mux, s, token, _ := totpFixture(t)
	codes, err := s.regenRecoveryCodes(1)
	if err != nil {
		t.Fatal(err)
	}
	rec := postTotp(mux, token, codes[0])
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) == 0 {
		t.Fatalf("recovery login: %d %s", rec.Code, rec.Body.String())
	}
	if _, ok := s.peekLoginPending(token); ok {
		t.Fatal("pending token survived a successful login")
	}
	token, _ = s.newLoginPending(1)
	if rec := postTotp(mux, token, codes[0]); rec.Code != http.StatusUnauthorized {
		t.Fatalf("used recovery code accepted again: %d", rec.Code)
	}
}
