package api

import (
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
)

// stallSMTP is a mail server that accepts connections and never greets: a
// send to it hangs until the test lets go of the connections.
func stallSMTP(t *testing.T) (port string, accepted <-chan struct{}, release func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	acc := make(chan struct{}, 16)
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			acc <- struct{}{}
		}
	}()
	release = func() {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
		conns = nil
	}
	t.Cleanup(func() { ln.Close(); release() })
	_, port, _ = net.SplitHostPort(ln.Addr().String())
	return port, acc, release
}

// Every mail a handler fires off runs through spawn: Shutdown waits for it,
// so a stop right after "ok" does not drop the mail, and a failed send's
// cleanup write never meets a closed database.
func TestMailSendsAreCountedForShutdown(t *testing.T) {
	mux, s, _, userC, adminID, userID := setupUsersTest(t)
	s.Mail = mailer.New(s.DB)
	port, accepted, release := stallSMTP(t)
	db.SetSetting(s.DB, "smtp_host", "127.0.0.1")
	db.SetSetting(s.DB, "smtp_port", port)
	db.SetSetting(s.DB, "smtp_security", "none")
	db.SetSetting(s.DB, "smtp_from", "weebsync@example.com")
	db.SetSetting(s.DB, "base_url", "https://example.com")
	db.SetSetting(s.DB, "registration_disabled", "false")
	setPassword(t, s, userID, "oldpassword1")
	if _, err := s.DB.Exec(`UPDATE users SET email_verified = 1, email_prefs = 'downloads' WHERE id IN (?, ?)`, adminID, userID); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name    string
		trigger func()
	}{
		{"forgot", func() {
			if rec := doReq(mux, "POST", "/api/auth/forgot", `{"email":"user@example.com"}`, nil); rec.Code != http.StatusOK {
				t.Fatalf("forgot: %d %s", rec.Code, rec.Body)
			}
		}},
		{"register", func() {
			if rec := doReq(mux, "POST", "/api/auth/register", `{"email":"new@example.com","password":"a long new password"}`, nil); rec.Code != http.StatusOK {
				t.Fatalf("register: %d %s", rec.Code, rec.Body)
			}
		}},
		{"reissueVerify", func() {
			res, err := s.DB.Exec(`INSERT INTO users (email, email_verified, verify_sent_at) VALUES ('late@example.com', 0, '')`)
			if err != nil {
				t.Fatal(err)
			}
			id, _ := res.LastInsertId()
			s.reissueVerify(id, "late@example.com")
		}},
		{"notify", func() { s.EmailNotify(userID, "downloads", "subject", "body", "") }},
		{"notifyAdmins", func() { s.notifyPendingUser("someone@example.com") }},
		{"approved", func() { s.mailApproved(userID) }},
		{"securityNotice", func() {
			if rec := doReq(mux, "PUT", "/api/auth/password", `{"current":"oldpassword1","new":"a much better phrase"}`, userC); rec.Code != http.StatusOK {
				t.Fatalf("password change: %d %s", rec.Code, rec.Body)
			}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			s.authLimiter.resetAll()
			c.trigger()
			select {
			case <-accepted:
			case <-time.After(5 * time.Second):
				t.Fatal("no mail was sent")
			}
			// the send hangs on the silent server right now
			if n := s.bg.Load(); n == 0 {
				t.Errorf("a mail is on its way but Shutdown would not wait for it")
			}
			release()
			deadline := time.Now().Add(5 * time.Second)
			for s.bg.Load() != 0 && time.Now().Before(deadline) {
				release() // a second mail of the same trigger may connect late
				time.Sleep(5 * time.Millisecond)
			}
			for len(accepted) > 0 {
				<-accepted
			}
		})
	}
}
