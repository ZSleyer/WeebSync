package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A provider that is down when the app starts (502 from the proxy in front of
// it during a cluster update) leaves sign-in off; once it answers again the
// retry loop brings it back without a restart. A cleared issuer stays off.
func TestOIDCKeepTrying(t *testing.T) {
	var up atomic.Bool
	prov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		base := "http://" + r.Host + "/oidc"
		json.NewEncoder(w).Encode(map[string]string{
			"issuer":                 base,
			"authorization_endpoint": base + "/auth",
			"token_endpoint":         base + "/token",
			"jwks_uri":               base + "/jwks",
		})
	}))
	t.Cleanup(prov.Close)

	d := dbtest.Open(t)
	for k, v := range map[string]string{
		"oidc_issuer":       prov.URL + "/oidc",
		"oidc_client_id":    "weebsync",
		"oidc_redirect_url": "http://localhost/api/auth/oidc/callback",
	} {
		if err := db.SetSetting(d, k, v); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(context.Background(), d)
	if m.Enabled() {
		t.Fatal("enabled while the provider answers 502")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.KeepTrying(ctx, 10*time.Millisecond); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	time.Sleep(50 * time.Millisecond)
	if m.Enabled() {
		t.Fatal("enabled while the provider is still down")
	}
	up.Store(true)
	deadline := time.Now().Add(5 * time.Second)
	for !m.Enabled() {
		if time.Now().After(deadline) {
			t.Fatal("sign-in did not come back once the provider answered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// an admin turns OIDC off: the loop must not switch it back on
	if err := db.SetSetting(d, "oidc_issuer", ""); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if m.Enabled() {
		t.Error("the retry loop revived a cleared issuer")
	}
}
