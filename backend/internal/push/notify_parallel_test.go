package push

import (
	"crypto/ecdh"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// swapNotifyNet points Notify at local test servers: their loopback address
// passes the endpoint guard, and their TLS client is used for sending.
func swapNotifyNet(t *testing.T, client *http.Client, deadline time.Duration) {
	t.Helper()
	oldAllowed, oldClient, oldDeadline := endpointAllowed, pushClient, notifyDeadline
	endpointAllowed = func(string) error { return nil }
	pushClient = func() *http.Client { return client }
	notifyDeadline = deadline
	t.Cleanup(func() { endpointAllowed, pushClient, notifyDeadline = oldAllowed, oldClient, oldDeadline })
}

func browserKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return b64.EncodeToString(k.PublicKey().Bytes()), b64.EncodeToString(secret)
}

// One push service that accepts the connection and never answers must not
// hold up the user's other devices, nor the caller (the test-push request,
// the sweep) past a shared deadline.
func TestNotifyHungEndpointDoesNotBlockOthers(t *testing.T) {
	release := make(chan struct{})
	hung := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer hung.Close()
	defer close(release) // runs before Close, which waits for the handlers
	var got atomic.Int32
	fast := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	fast.TLS = hung.TLS
	fast.StartTLS()
	defer fast.Close()

	d := vapidTestDB(t)
	s, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'one@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	// the hung device first: sent one after the other, it would starve the rest
	for i, srv := range []*httptest.Server{hung, hung, fast} {
		p, a := browserKeys(t)
		if err := s.Subscribe(1, srv.URL+"/sub/"+string(rune('a'+i)), p, a); err != nil {
			t.Fatal(err)
		}
	}
	swapNotifyNet(t, hung.Client(), 500*time.Millisecond)

	start := time.Now()
	s.Notify(1, Notification{Title: "x"})
	if took := time.Since(start); took > 3*time.Second {
		t.Errorf("Notify took %v, past its deadline", took)
	}
	if got.Load() != 1 {
		t.Errorf("responsive device got %d pushes, want 1", got.Load())
	}
}
