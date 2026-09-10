package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// A logout token signed by a key this test owns: enough to drive the handler
// end to end without an identity provider on the network.
type testKeys struct{ key *rsa.PrivateKey }

func (k testKeys) VerifySignature(_ context.Context, raw string) ([]byte, error) {
	sig, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		return nil, err
	}
	return sig.Verify(&k.key.PublicKey)
}

func (k testKeys) sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: k.key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func backchannelFixture(t *testing.T) (*Manager, testKeys, *sql.DB) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keys := testKeys{key}
	m := &Manager{DB: d}
	m.cur = &OIDC{
		verifier: oidc.NewVerifier("https://idp.example.com", keys, &oidc.Config{ClientID: "weebsync"}),
	}
	return m, keys, d
}

// session rows the handler is meant to pick from: two logins of one provider
// session, one of another, and a password login that has no provider session
// at all.
func seedSessions(t *testing.T, d *sql.DB) {
	t.Helper()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash, is_admin) VALUES (1, 'a@example.com', '', 1), (2, 'b@example.com', '', 0)`); err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	rows := []struct {
		hash, sid, sub string
		user           int64
	}{
		{"h1", "sid-1", "user-a", 1},
		{"h2", "sid-1", "user-a", 1},
		{"h3", "sid-2", "user-a", 1},
		{"h4", "", "", 2},
	}
	for _, r := range rows {
		if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at, oidc_sid, oidc_sub) VALUES (?, ?, ?, ?, ?)`,
			r.hash, r.user, exp, r.sid, r.sub); err != nil {
			t.Fatal(err)
		}
	}
}

func post(m *Manager, token string) *httptest.ResponseRecorder {
	body := strings.NewReader(url.Values{"logout_token": {token}}.Encode())
	r := httptest.NewRequest("POST", "/api/auth/oidc/backchannel-logout", body)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	m.BackchannelLogoutHandler(rec, r)
	return rec
}

func count(t *testing.T, d *sql.DB) int {
	t.Helper()
	var n int
	if err := d.QueryRow(`SELECT count(*) FROM sessions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func logoutClaims(sid, sub string) map[string]any {
	c := map[string]any{
		"iss":    "https://idp.example.com",
		"aud":    "weebsync",
		"iat":    time.Now().Unix(),
		"exp":    time.Now().Add(2 * time.Minute).Unix(),
		"jti":    "jti-1",
		"events": map[string]any{backchannelEvent: map[string]any{}},
	}
	if sid != "" {
		c["sid"] = sid
	}
	if sub != "" {
		c["sub"] = sub
	}
	return c
}

// The session named by sid ends, and only that one: the other provider session
// and the password login stay.
func TestBackchannelLogoutEndsTheNamedSession(t *testing.T) {
	m, keys, d := backchannelFixture(t)
	seedSessions(t, d)

	if rec := post(m, keys.sign(t, logoutClaims("sid-1", "user-a"))); rec.Code != 200 {
		t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
	}
	if n := count(t, d); n != 2 {
		t.Errorf("both logins of sid-1 should be gone, %d rows left", n)
	}
	var left string
	d.QueryRow(`SELECT group_concat(token_hash) FROM sessions ORDER BY token_hash`).Scan(&left)
	if !strings.Contains(left, "h3") || !strings.Contains(left, "h4") {
		t.Errorf("wrong sessions survived: %q", left)
	}
}

// A provider may name the session and nothing else - the subject is optional
// when a sid is there, and go-oidc must not insist on it.
func TestBackchannelLogoutAcceptsSidWithoutSubject(t *testing.T) {
	m, keys, d := backchannelFixture(t)
	seedSessions(t, d)

	if rec := post(m, keys.sign(t, logoutClaims("sid-1", ""))); rec.Code != 200 {
		t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
	}
	if n := count(t, d); n != 2 {
		t.Errorf("both logins of sid-1 should be gone, %d rows left", n)
	}
}

// Without a sid the provider means every login of that subject.
func TestBackchannelLogoutWithoutSidEndsTheSubject(t *testing.T) {
	m, keys, d := backchannelFixture(t)
	seedSessions(t, d)

	if rec := post(m, keys.sign(t, logoutClaims("", "user-a"))); rec.Code != 200 {
		t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
	}
	// only the password login is left
	if n := count(t, d); n != 1 {
		t.Errorf("every provider session of user-a should be gone, %d rows left", n)
	}
}

// Everything that is not a logout token from our provider must change nothing.
func TestBackchannelLogoutRefusesAnythingElse(t *testing.T) {
	m, keys, d := backchannelFixture(t)
	seedSessions(t, d)

	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	foreign := testKeys{other}

	noEvent := logoutClaims("sid-1", "user-a")
	delete(noEvent, "events")
	withNonce := logoutClaims("sid-1", "user-a")
	withNonce["nonce"] = "n-1"
	noSession := logoutClaims("", "")
	expired := logoutClaims("sid-1", "user-a")
	expired["exp"] = time.Now().Add(-time.Minute).Unix()
	wrongAud := logoutClaims("sid-1", "user-a")
	wrongAud["aud"] = "someone-else"

	for _, c := range []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"garbage", "not-a-token"},
		{"signed by someone else", foreign.sign(t, logoutClaims("sid-1", "user-a"))},
		{"no logout event", keys.sign(t, noEvent)},
		{"id token in disguise", keys.sign(t, withNonce)},
		{"names no session", keys.sign(t, noSession)},
		{"expired", keys.sign(t, expired)},
		{"for another client", keys.sign(t, wrongAud)},
	} {
		rec := post(m, c.token)
		if rec.Code == http.StatusOK {
			t.Errorf("%s: accepted, want a refusal", c.name)
		}
		if n := count(t, d); n != 4 {
			t.Fatalf("%s: sessions were touched, %d rows left", c.name, n)
		}
	}
}
