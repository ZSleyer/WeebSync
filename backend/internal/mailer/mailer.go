// Package mailer sends transactional email (verification, notifications) over
// an admin-configured SMTP server. When SMTP is not configured it is a no-op
// and Configured() reports false, so features gate on it cleanly.
package mailer

import (
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
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
	// the envelope sender must be a real address: a bare name gets
	// SRS-rewritten by relays into garbage and lands in spam
	if _, err := mail.ParseAddress(c.from); err != nil {
		return c, fmt.Errorf("smtp from %q is not a valid email address - set a real sender in the email settings", c.from)
	}
	// env override wins (matches SettingOrEnv semantics); the DB value is
	// stored base64(AES-GCM) like other secrets
	if pw := os.Getenv("SMTP_PASSWORD"); pw != "" {
		c.password = pw
	} else if enc := db.Setting(s.DB, "smtp_password"); enc != "" {
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return c, fmt.Errorf("smtp password decode: %w", err)
		}
		pw, err := secret.Decrypt(raw)
		if err != nil {
			return c, fmt.Errorf("smtp password decrypt: %w", err)
		}
		c.password = pw
	}
	return c, nil
}

// Send delivers an email to one recipient: text always, html as the rich
// alternative when non-empty. Blocking; call from a goroutine for
// fire-and-forget notifications.
func (s *Service) Send(to, subject, text, html string) error {
	c, err := s.load()
	if err != nil {
		return err
	}
	// Parse to/from and use only the bare addr-spec: rejects CRLF/multi-address
	// and strips any display name, so neither can inject email headers. Using the
	// parsed value (not the raw input) is what makes the header content safe.
	toAddr, err := mail.ParseAddress(to)
	if err != nil {
		return fmt.Errorf("invalid recipient: %w", err)
	}
	fromAddr, err := mail.ParseAddress(c.from)
	if err != nil {
		return fmt.Errorf("invalid sender: %w", err)
	}
	to, c.from = toAddr.Address, fromAddr.Address
	addr := net.JoinHostPort(c.host, strconv.Itoa(c.port))
	msg := buildMessage(c.from, to, subject, text, html)

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

// buildMessage assembles a standards-compliant message: display-name From,
// RFC-2047-encoded subject (umlauts/dashes must never arrive as "???"),
// Date and Message-ID headers (their absence scores spam points), and a
// multipart/alternative body when an HTML part is provided.
func buildMessage(from, to, subject, text, html string) []byte {
	domain := "weebsync"
	if i := strings.LastIndex(from, "@"); i != -1 {
		domain = from[i+1:]
	}
	idRaw := make([]byte, 16)
	rand.Read(idRaw)

	var b strings.Builder
	fmt.Fprintf(&b, "From: %s <%s>\r\n", mime.QEncoding.Encode("utf-8", "WeebSync"), from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: <%s@%s>\r\n", hex.EncodeToString(idRaw), domain)
	b.WriteString("MIME-Version: 1.0\r\n")

	if html == "" {
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		b.WriteString(qp(text))
		return []byte(b.String())
	}

	boundaryRaw := make([]byte, 12)
	rand.Read(boundaryRaw)
	boundary := "ws-" + hex.EncodeToString(boundaryRaw)
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n%s\r\n", boundary, qp(text))
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n%s\r\n", boundary, qp(html))
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return []byte(b.String())
}

// qp encodes a body as quoted-printable: SMTP folds raw lines longer than
// 998 chars mid-word (Gmail renders the fold as a space), QP keeps lines
// short with soft breaks instead.
func qp(s string) string {
	var b strings.Builder
	w := quotedprintable.NewWriter(&b)
	w.Write([]byte(s))
	w.Close()
	return b.String()
}
