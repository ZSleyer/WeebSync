package mailer

import (
	"net/mail"
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
