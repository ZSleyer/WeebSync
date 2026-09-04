package mailer

import (
	"io"
	"net"
	"net/mail"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
)

// Send() gates to/from through mail.ParseAddress so CRLF cannot inject headers.
// Guard the contract the fix relies on.
func TestAddressRejectsHeaderInjection(t *testing.T) {
	bad := []string{"a@b.com\r\nBcc: evil@x.com", "a@b.com\nSubject: x", "a@b.com, c@d.com"}
	for _, addr := range bad {
		if _, err := mail.ParseAddress(addr); err == nil {
			t.Errorf("ParseAddress accepted injection payload %q", addr)
		}
	}
	if _, err := mail.ParseAddress("to@example.com"); err != nil {
		t.Errorf("ParseAddress rejected valid address: %v", err)
	}
}

func TestBuildMessage(t *testing.T) {
	msg := string(buildMessage("ws@example.com", "to@example.com", "WeebSync – Download fertig", "text body", "<b>html body</b>"))

	// non-ASCII subject must be RFC-2047 encoded, never raw (arrives as "???")
	if !strings.Contains(msg, "Subject: =?utf-8?q?") {
		t.Errorf("subject not RFC-2047 encoded:\n%s", msg)
	}
	// From needs display name AND address (bare names score spam points)
	if !strings.Contains(msg, "From: WeebSync <ws@example.com>\r\n") {
		t.Errorf("from header malformed:\n%s", msg)
	}
	for _, h := range []string{"Date: ", "Message-ID: <", "@example.com>"} {
		if !strings.Contains(msg, h) {
			t.Errorf("missing %q:\n%s", h, msg)
		}
	}
	if !strings.Contains(msg, "multipart/alternative") ||
		!strings.Contains(msg, "text body") || !strings.Contains(msg, "<b>html body</b>") {
		t.Errorf("multipart body incomplete:\n%s", msg)
	}

	// no html part → plain text message
	plain := string(buildMessage("ws@example.com", "to@example.com", "Hi", "just text", ""))
	if !strings.Contains(plain, "Content-Type: text/plain") || strings.Contains(plain, "multipart") {
		t.Errorf("plain message malformed:\n%s", plain)
	}
	if !strings.Contains(plain, "Subject: Hi\r\n") {
		t.Errorf("ascii subject should stay readable:\n%s", plain)
	}
}

type smtpRecord struct {
	rcpt string
	data string
	mail bool
}

// fakeSMTP serves one session on loopback; starttls controls whether EHLO
// advertises the extension.
func fakeSMTP(t *testing.T, starttls bool) (int, *smtpRecord) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	rec := &smtpRecord{}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		tp := textproto.NewConn(conn)
		tp.PrintfLine("220 fake ESMTP")
		for {
			line, err := tp.ReadLine()
			if err != nil {
				return
			}
			switch cmd := strings.ToUpper(strings.SplitN(line, " ", 2)[0]); cmd {
			case "EHLO", "HELO":
				if starttls {
					tp.PrintfLine("250-fake")
					tp.PrintfLine("250-STARTTLS")
				} else {
					tp.PrintfLine("250-fake")
				}
				tp.PrintfLine("250 OK")
			case "MAIL":
				rec.mail = true
				tp.PrintfLine("250 OK")
			case "RCPT":
				rec.rcpt = strings.TrimSuffix(strings.TrimPrefix(line[len("RCPT TO:"):], "<"), ">")
				tp.PrintfLine("250 OK")
			case "DATA":
				tp.PrintfLine("354 go")
				b, _ := io.ReadAll(tp.DotReader())
				rec.data = string(b)
				tp.PrintfLine("250 queued")
			case "QUIT":
				tp.PrintfLine("221 bye")
				return
			default:
				tp.PrintfLine("250 OK")
			}
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	return p, rec
}

func TestSendSMTPRequiresSTARTTLS(t *testing.T) {
	port, rec := fakeSMTP(t, false)
	err := sendSMTP(config{host: "127.0.0.1", port: port, from: "a@b.c", security: "starttls"}, nil, "to@x.y", []byte("hi"))
	if err == nil || !strings.Contains(err.Error(), "does not offer STARTTLS") {
		t.Fatalf("plain server accepted in starttls mode: %v", err)
	}
	if rec.mail {
		t.Fatal("MAIL was sent over plaintext")
	}
}

func TestSendSMTPPlainDelivers(t *testing.T) {
	port, rec := fakeSMTP(t, false)
	if err := sendSMTP(config{host: "127.0.0.1", port: port, from: "a@b.c", security: "none"}, nil, "to@x.y", []byte("Subject: t\r\n\r\nhello")); err != nil {
		t.Fatal(err)
	}
	if rec.rcpt != "to@x.y" || !strings.Contains(rec.data, "hello") {
		t.Fatalf("rcpt=%q data=%q", rec.rcpt, rec.data)
	}
}
