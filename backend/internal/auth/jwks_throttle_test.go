package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/coreos/go-oidc/v3/oidc/oidctest"
)

func TestJWKSRefetchIsThrottled(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &oidctest.Server{PublicKeys: []oidctest.PublicKey{{PublicKey: priv.Public(), KeyID: "k1", Algorithm: oidc.RS256}}}
	var keyFetches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			keyFetches.Add(1)
		}
		idp.ServeHTTP(w, r)
	}))
	defer srv.Close()
	idp.SetIssuer(srv.URL)

	ctx := context.Background()
	provider, err := oidc.NewProvider(ctx, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	v := newIDTokenVerifier(ctx, provider, srv.URL, &oidc.Config{ClientID: "client"})
	token := func(key *rsa.PrivateKey, kid string) string {
		claims := `{"iss":"` + srv.URL + `","aud":"client","sub":"u","exp":` + strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + `}`
		return oidctest.SignIDToken(key, kid, oidc.RS256, claims)
	}

	if _, err := v.Verify(ctx, token(priv, "k1")); err != nil {
		t.Fatalf("valid token: %v", err)
	}
	for i := range 20 {
		if _, err := v.Verify(ctx, token(other, "made-up-"+strconv.Itoa(i))); err == nil {
			t.Fatal("token with an unknown key verified")
		}
	}
	if n := keyFetches.Load(); n != 1 {
		t.Errorf("JWKS fetched %d times for 21 tokens, want 1", n)
	}
	if _, err := v.Verify(ctx, token(priv, "k1")); err != nil {
		t.Errorf("cached key stopped working during the cooldown: %v", err)
	}
}

type countingTransport struct{ n int }

func (c *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c.n++
	rec := httptest.NewRecorder()
	rec.WriteString(`{"keys":[]}`)
	return rec.Result(), nil
}

func TestJWKSThrottleRefetchesAfterInterval(t *testing.T) {
	base := &countingTransport{}
	now := time.Unix(1000, 0)
	tr := &jwksThrottle{base: base, interval: 10 * time.Second, now: func() time.Time { return now }}
	req, _ := http.NewRequest(http.MethodGet, "http://idp.example.com/keys", nil)
	get := func() {
		t.Helper()
		resp, err := tr.RoundTrip(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("round trip: %v %v", resp, err)
		}
		resp.Body.Close()
	}
	get()
	now = now.Add(9 * time.Second)
	get()
	if base.n != 1 {
		t.Fatalf("fetches within the interval = %d, want 1", base.n)
	}
	now = now.Add(2 * time.Second)
	get()
	if base.n != 2 {
		t.Errorf("fetches after the interval = %d, want 2", base.n)
	}
}
