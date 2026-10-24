package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// swapCeremonyStore gives a test an empty ceremony store of the given size.
func swapCeremonyStore(t *testing.T, size int) {
	t.Helper()
	waMu.Lock()
	sessions, order, max, clients := waSessions, waOrder, waMaxCeremonies, waClients
	waSessions, waOrder, waMaxCeremonies, waClients = map[string]waCeremony{}, nil, size, map[string]int{}
	waMu.Unlock()
	t.Cleanup(func() {
		waMu.Lock()
		waSessions, waOrder, waMaxCeremonies, waClients = sessions, order, max, clients
		waMu.Unlock()
	})
}

// Passkey login/begin needs no login and every call stored a ceremony for
// five minutes, unbounded, with a walk over the whole store on each insert.
// The store now holds at most waMaxCeremonies, the oldest giving way.
func TestWebAuthnCeremonyStoreIsBounded(t *testing.T) {
	swapCeremonyStore(t, 50)
	ids := make([]string, 0, 200)
	for range 200 {
		ids = append(ids, waPutAny(t))
	}
	waMu.Lock()
	n, queued := len(waSessions), len(waOrder)
	waMu.Unlock()
	if n != 50 || queued != 50 {
		t.Fatalf("store holds %d (queue %d), want 50", n, queued)
	}
	// the newest are kept, the oldest made room
	if waTake(ids[199]) == nil {
		t.Error("newest ceremony gone")
	}
	if waTake(ids[0]) != nil {
		t.Error("oldest ceremony survived a full store")
	}
}

// Expired ceremonies leave from the front of the queue on the next insert;
// taken ones do not linger in it either.
func TestWebAuthnCeremonyStoreSweepsExpired(t *testing.T) {
	swapCeremonyStore(t, 50)
	ids := make([]string, 0, 10)
	for range 10 {
		ids = append(ids, waPutAny(t))
	}
	// the first four ran out; the fifth was taken
	waMu.Lock()
	for _, id := range ids[:4] {
		c := waSessions[id]
		c.exp = time.Now().Add(-time.Second)
		waSessions[id] = c
	}
	waMu.Unlock()
	waTake(ids[4])
	waPutAny(t)
	waMu.Lock()
	n, queued := len(waSessions), len(waOrder)
	waMu.Unlock()
	if n != 6 || queued != 6 {
		t.Fatalf("after the sweep: %d stored, %d queued, want 6 and 6", n, queued)
	}
	if waTake(ids[5]) == nil {
		t.Error("a live ceremony was swept")
	}
}

// Ids of taken ceremonies behind a live one cannot pile up past twice the
// store's size.
func TestWebAuthnCeremonyQueueStaysBounded(t *testing.T) {
	swapCeremonyStore(t, 10)
	waPutAny(t) // live, at the front
	for range 100 {
		waTake(waPutAny(t))
	}
	waMu.Lock()
	n, queued := len(waSessions), len(waOrder)
	waMu.Unlock()
	if n != 1 || queued > 21 {
		t.Fatalf("%d stored, %d queued", n, queued)
	}
}

var anyClient atomic.Int64

// waPutAny stores a ceremony for a client of its own, so the per-client cap
// stays out of the way of tests about the store as a whole.
func waPutAny(t *testing.T) string {
	t.Helper()
	id, ok := waPut(&webauthn.SessionData{}, "client-"+strconv.FormatInt(anyClient.Add(1), 10))
	if !ok {
		t.Fatal("a ceremony for a new client was refused")
	}
	return id
}

// One client flooding login/begin used to push everyone else's ceremonies
// out of the store, so their passkey sign-in failed with "expired login
// session". A client now holds at most waMaxPerClient ceremonies at once;
// past that it is refused and the others' ceremonies stay.
func TestWebAuthnCeremoniesCappedPerClient(t *testing.T) {
	swapCeremonyStore(t, 20)
	defer func(n int) { waMaxPerClient = n }(waMaxPerClient)
	waMaxPerClient = 5
	victim, ok := waPut(&webauthn.SessionData{}, "198.51.100.7")
	if !ok {
		t.Fatal("first ceremony refused")
	}
	refused := 0
	for range 100 {
		if _, ok := waPut(&webauthn.SessionData{}, "192.0.2.1"); !ok {
			refused++
		}
	}
	if refused != 95 {
		t.Fatalf("flooding client refused %d of 100, want 95", refused)
	}
	if waTake(victim) == nil {
		t.Fatal("another client's ceremony was evicted by the flood")
	}
	if _, ok := waPut(&webauthn.SessionData{}, "203.0.113.9"); !ok {
		t.Error("a third client was refused")
	}
	// once its ceremonies run out (time passes for all of them alike) the
	// client gets its turn back
	waMu.Lock()
	for id, c := range waSessions {
		if c.client == "192.0.2.1" {
			c.exp = time.Now().Add(-time.Second)
			waSessions[id] = c
		}
	}
	waMu.Unlock()
	if _, ok := waPut(&webauthn.SessionData{}, "192.0.2.1"); !ok {
		t.Error("an expired ceremony still counted against its client")
	}
}

// Over HTTP: login/begin from a client at its cap answers 429, and a
// different client still gets a ceremony.
func TestWebAuthnLoginBeginCappedPerClient(t *testing.T) {
	mux, s, _, _, _, _ := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	swapCeremonyStore(t, 100)
	defer func(n int) { waMaxPerClient = n }(waMaxPerClient)
	waMaxPerClient = 3
	begin := func(addr string) int {
		req := httptest.NewRequest("POST", "/api/auth/webauthn/login/begin", nil)
		req.RemoteAddr = addr
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	for i := range 3 {
		if code := begin("192.0.2.1:4000"); code != http.StatusOK {
			t.Fatalf("begin %d: %d", i, code)
		}
	}
	if code := begin("192.0.2.1:4001"); code != http.StatusTooManyRequests {
		t.Errorf("begin past the cap: %d, want 429", code)
	}
	if code := begin("198.51.100.7:4000"); code != http.StatusOK {
		t.Errorf("another client: %d, want 200", code)
	}
}
