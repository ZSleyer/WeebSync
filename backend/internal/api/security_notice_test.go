package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
)

// Changing the password, switching TOTP on and removing a key each mail the
// owner, in their language, without a link.
func TestSecurityNotices(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	s.DB.Exec(`UPDATE users SET locale = 'de' WHERE id = ?`, userID)
	setPassword(t, s, userID, "oldpassword1")

	type sent struct{ to, subject, text string }
	got := make(chan sent, 4)
	s.securityMail = func(to, subject, text, _ string) error {
		got <- sent{to, subject, text}
		return nil
	}
	next := func() sent {
		t.Helper()
		select {
		case m := <-got:
			return m
		case <-time.After(2 * time.Second):
			t.Fatal("no security notice sent")
			return sent{}
		}
	}

	if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"oldpassword1","new":"a much better phrase"}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("change: %d %s", rec.Code, rec.Body)
	}
	m := next()
	if m.to != "user@example.com" || !strings.Contains(m.subject, "Passwort wurde geändert") {
		t.Errorf("password notice: %+v", m)
	}
	if strings.Contains(m.text, "http") {
		t.Errorf("notice carries a link: %s", m.text)
	}
	if !strings.Contains(m.text, "192.0.2.1") {
		t.Errorf("notice does not say from where: %s", m.text)
	}

	// a wrong password changes nothing and mails nothing
	doReq(mux, "PUT", "/api/auth/password", `{"current":"wrong","new":"another long phrase"}`, userC)
	select {
	case m := <-got:
		t.Errorf("notice for a refused change: %+v", m)
	case <-time.After(100 * time.Millisecond):
	}
}
