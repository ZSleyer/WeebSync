// Package mailer sends transactional email (verification, notifications) over
// an admin-configured SMTP server. When SMTP is not configured it is a no-op
// and Configured() reports false, so features gate on it cleanly.
package mailer

import (
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

type Service struct{ DB *sql.DB }

func New(d *sql.DB) *Service { return &Service{DB: d} }

// Configured reports whether an SMTP host is set. Features that send email
// should check this first.
func (s *Service) Configured() bool {
	return db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST") != ""
}

type config struct {
	host, from, username, password, security string
	port                                     int
}

func (s *Service) load() (config, error) {
	c := config{
		host:     db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST"),
		from:     db.SettingOrEnv(s.DB, "smtp_from", "SMTP_FROM"),
		username: db.SettingOrEnv(s.DB, "smtp_username", "SMTP_USERNAME"),
		security: db.SettingOrEnv(s.DB, "smtp_security", "SMTP_SECURITY"), // starttls | tls | none
	}
	if c.host == "" {
		return c, fmt.Errorf("smtp not configured")
	}
	c.port, _ = strconv.Atoi(db.SettingOrEnv(s.DB, "smtp_port", "SMTP_PORT"))
	if c.port == 0 {
		c.port = 587
	}
	if c.security == "" {
		c.security = "starttls"
	}
	if c.from == "" {
		c.from = c.username
	}
	// password is stored base64(AES-GCM) like other secrets
	if enc := db.Setting(s.DB, "smtp_password"); enc != "" {
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return c, fmt.Errorf("smtp password decode: %w", err)
		}
		pw, err := secret.Decrypt(raw)
		if err != nil {
			return c, fmt.Errorf("smtp password decrypt: %w", err)
		}
		c.password = pw
	} else {
		c.password = os.Getenv("SMTP_PASSWORD")
	}
	return c, nil
}

// Send delivers a plain-text email to one recipient. Blocking; call from a
// goroutine for fire-and-forget notifications.
func (s *Service) Send(to, subject, body string) error {
	c, err := s.load()
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(c.host, strconv.Itoa(c.port))
	msg := buildMessage(c.from, to, subject, body)

	var auth smtp.Auth
	if c.username != "" {
		auth = smtp.PlainAuth("", c.username, c.password, c.host)
	}

	switch c.security {
	case "tls": // implicit TLS (usually port 465)
		return sendImplicitTLS(addr, c.host, auth, c.from, to, msg)
	default: // starttls / none, both go through smtp.SendMail (STARTTLS if offered)
		return smtp.SendMail(addr, auth, c.from, []string{to}, msg)
	}
}

func sendImplicitTLS(addr, host string, auth smtp.Auth, from, to string, msg []byte) error {
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return err
	}
	cl, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer cl.Close()
	if auth != nil {
		if err := cl.Auth(auth); err != nil {
			return err
		}
	}
	if err := cl.Mail(from); err != nil {
		return err
	}
	if err := cl.Rcpt(to); err != nil {
		return err
	}
	wc, err := cl.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(msg); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return cl.Quit()
}

func buildMessage(from, to, subject, body string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}
