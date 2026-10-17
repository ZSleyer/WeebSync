package mailer

import (
	"strings"
	"testing"
)

func TestSendSMTPUnknownSecurityRefused(t *testing.T) {
	port, _ := fakeSMTP(t, false)
	for _, sec := range []string{"plain", "STARTTLS", "off", "ssl"} {
		err := sendSMTP(config{host: "127.0.0.1", port: port, from: "a@b.c", security: sec}, nil, "to@x.y", []byte("hi"))
		if err == nil || !strings.Contains(err.Error(), "unknown smtp_security") {
			t.Errorf("security %q: %v, want refusal", sec, err)
		}
	}
}
