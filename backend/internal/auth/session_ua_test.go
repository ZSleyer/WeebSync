package auth

import (
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A user agent cut at its byte cap must not end in half a character: the
// session list would show U+FFFD for it.
func TestCreateSessionCapsUserAgentOnRuneBoundary(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	// "é" is two bytes; byte 300 falls in the middle of one
	r.Header.Set("User-Agent", strings.Repeat("a", 299)+strings.Repeat("é", 10))
	if err := CreateSession(d, httptest.NewRecorder(), r, 1, false); err != nil {
		t.Fatal(err)
	}
	var ua string
	if err := d.QueryRow(`SELECT user_agent FROM sessions WHERE user_id = 1`).Scan(&ua); err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(ua) || len(ua) > 300 || !strings.HasPrefix(ua, strings.Repeat("a", 299)) {
		t.Errorf("stored user agent ends %q (%d bytes, valid %v)", ua[290:], len(ua), utf8.ValidString(ua))
	}
}
