package api

import (
	"net/http/httptest"
	"testing"
)

// The client percent-encodes the passkey's name, since a header carries only
// bytes; the server stores it decoded. A value that is no valid encoding (an
// older client sending "100%") is kept as sent, and raw Latin-1 bytes never
// reach the database as invalid UTF-8.
func TestWebAuthnNameHeader(t *testing.T) {
	for raw, want := range map[string]string{
		"":                                    "Passkey",
		"Phone":                               "Phone",
		"Chadis%20Handy%20%E2%80%93%20privat": "Chadis Handy – privat",
		"%E6%97%A5%E6%9C%AC":                  "日本",
		"a+b":                                 "a+b",
		"100%":                                "100%",
		"B\xfcro":                             "Bro",
	} {
		r := httptest.NewRequest("POST", "/api/auth/webauthn/register/finish", nil)
		r.Header.Set("X-WA-Name", raw)
		if got := waName(r); got != want {
			t.Errorf("X-WA-Name %q: got %q, want %q", raw, got, want)
		}
	}
}
