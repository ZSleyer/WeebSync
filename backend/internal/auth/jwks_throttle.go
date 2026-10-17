package auth

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/coreos/go-oidc/v3/oidc"
)

// newIDTokenVerifier builds the ID-token verifier with a key set whose JWKS
// fetches are throttled. Without a jwks_uri in the discovery document the
// library's own verifier is the fallback.
func newIDTokenVerifier(ctx context.Context, provider *oidc.Provider, issuer string, cfg *oidc.Config) *oidc.IDTokenVerifier {
	var d struct {
		JWKS string `json:"jwks_uri"`
	}
	if provider.Claims(&d) != nil || d.JWKS == "" {
		return provider.Verifier(cfg)
	}
	c := netguard.Client(10 * time.Second)
	c.Transport = &jwksThrottle{base: c.Transport, interval: jwksRefetchInterval}
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(ctx, c), d.JWKS)
	return oidc.NewVerifier(issuer, keys, cfg)
}

// jwksRefetchInterval is the shortest time between two real fetches of the
// provider's key set.
const jwksRefetchInterval = 10 * time.Second

// jwksThrottle is the transport under go-oidc's RemoteKeySet. That key set
// fetches the JWKS again for every token whose signature it cannot verify
// from its cache, so anyone who can reach the login callback could make this
// server hammer the identity provider with tokens carrying a made-up key id.
// Within the interval the last answer is replayed instead: tokens signed with
// a cached key verify as before, a rotated key shows up after at most the
// interval, an unknown one fails without a request.
type jwksThrottle struct {
	base     http.RoundTripper
	interval time.Duration
	now      func() time.Time

	mu      sync.Mutex
	last    time.Time
	status  int
	header  http.Header
	body    []byte
	lastErr error
}

func (t *jwksThrottle) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now
	if t.now != nil {
		now = t.now
	}
	if !t.last.IsZero() && now().Sub(t.last) < t.interval {
		if t.lastErr != nil {
			return nil, t.lastErr
		}
		return &http.Response{
			Status:     http.StatusText(t.status),
			StatusCode: t.status,
			Header:     t.header.Clone(),
			Body:       io.NopCloser(bytes.NewReader(t.body)),
			Request:    req,
		}, nil
	}
	t.last = now()
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		t.lastErr = err
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	resp.Body.Close()
	if err != nil {
		t.lastErr = err
		return nil, err
	}
	t.lastErr, t.status, t.header, t.body = nil, resp.StatusCode, resp.Header.Clone(), body
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, nil
}
