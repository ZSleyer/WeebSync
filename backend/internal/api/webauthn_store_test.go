package api

import (
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// swapCeremonyStore gives a test an empty ceremony store of the given size.
func swapCeremonyStore(t *testing.T, size int) {
	t.Helper()
	waMu.Lock()
	sessions, order, max := waSessions, waOrder, waMaxCeremonies
	waSessions, waOrder, waMaxCeremonies = map[string]waCeremony{}, nil, size
	waMu.Unlock()
	t.Cleanup(func() {
		waMu.Lock()
		waSessions, waOrder, waMaxCeremonies = sessions, order, max
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
		ids = append(ids, waPut(&webauthn.SessionData{}))
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
		ids = append(ids, waPut(&webauthn.SessionData{}))
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
	waPut(&webauthn.SessionData{})
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
	waPut(&webauthn.SessionData{}) // live, at the front
	for range 100 {
		waTake(waPut(&webauthn.SessionData{}))
	}
	waMu.Lock()
	n, queued := len(waSessions), len(waOrder)
	waMu.Unlock()
	if n != 1 || queued > 21 {
		t.Fatalf("%d stored, %d queued", n, queued)
	}
}
