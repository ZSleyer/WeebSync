package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"
)

// swapHashGate gives a test its own gate and key derivation, so it can hold
// slots and count runs without paying for argon2.
func swapHashGate(t *testing.T, slots int, fn func([]byte, []byte, uint32, uint32, uint8, uint32) []byte) {
	t.Helper()
	gate, idk, wait := hashGate, argonIDKey, hashWaitMax
	hashGate, argonIDKey, hashWaitMax = make(chan struct{}, slots), fn, time.Hour
	t.Cleanup(func() { hashGate, argonIDKey, hashWaitMax = gate, idk, wait })
}

// Every argon2id run holds 64 MiB; parallel sign-ins must not run more of
// them at once than the gate allows, however many arrive.
func TestHashGateCapsConcurrentRuns(t *testing.T) {
	hash := legacyHash(t, "correct horse battery")
	const slots, callers = 2, 8
	var mu sync.Mutex
	active, peak, runs := 0, 0, 0
	entered := make(chan struct{}, callers)
	release := make(chan struct{})
	swapHashGate(t, slots, func(_, _ []byte, _, _ uint32, _ uint8, keyLen uint32) []byte {
		mu.Lock()
		active++
		runs++
		peak = max(peak, active)
		mu.Unlock()
		entered <- struct{}{}
		<-release
		mu.Lock()
		active--
		mu.Unlock()
		return make([]byte, keyLen)
	})
	var wg sync.WaitGroup
	for range callers {
		wg.Go(func() {
			if _, err := HashPasswordContext(context.Background(), "correct horse battery"); err != nil {
				t.Error(err)
			}
		})
	}
	for range slots {
		<-entered
	}
	// every slot is held: a request that has already ended gives up at once
	// instead of queueing, and burns nothing
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := VerifyPasswordContext(ctx, "correct horse battery", hash); !errors.Is(err, ErrHashBusy) {
		t.Fatalf("verify with the gate full and the request gone: %v, want ErrHashBusy", err)
	}
	if err := DummyVerifyContext(ctx, "anything at all"); !errors.Is(err, ErrHashBusy) {
		t.Fatalf("dummy verify with the gate full: %v, want ErrHashBusy", err)
	}
	close(release)
	wg.Wait()
	if peak != slots || runs != callers {
		t.Fatalf("peak %d runs %d, want peak %d runs %d", peak, runs, slots, callers)
	}
}

// The dummy check for an unknown address must always cost a real hash. When
// the dummy hash was built through the gate on first use, a full gate then
// left it empty for good, and every later unknown address answered at once:
// a lasting timing oracle for which addresses have accounts.
func TestDummyVerifyAlwaysPaysTheHash(t *testing.T) {
	runs := 0
	swapHashGate(t, 1, func(_, _ []byte, _, _ uint32, _ uint8, keyLen uint32) []byte {
		runs++
		return make([]byte, keyLen)
	})
	hashWaitMax = time.Nanosecond
	hashGate <- struct{}{} // the very first unknown address finds the gate full
	if err := DummyVerifyContext(context.Background(), "guess-guess"); !errors.Is(err, ErrHashBusy) {
		t.Fatalf("dummy check with the gate full: %v, want ErrHashBusy", err)
	}
	<-hashGate
	hashWaitMax = time.Hour
	for i := range 3 {
		if err := DummyVerifyContext(context.Background(), "guess-guess"); err != nil {
			t.Fatal(err)
		}
		if runs != i+1 {
			t.Fatalf("dummy check %d ran argon2 %d times, want %d", i+1, runs, i+1)
		}
	}
}

// A caller that never gets a slot gives up after hashWaitMax rather than
// queueing for as long as the flood lasts.
func TestHashGateGivesUpWhenFull(t *testing.T) {
	runs := 0
	swapHashGate(t, 1, func(_, _ []byte, _, _ uint32, _ uint8, keyLen uint32) []byte {
		runs++
		return make([]byte, keyLen)
	})
	hashWaitMax = time.Nanosecond
	hashGate <- struct{}{}
	if _, err := HashPasswordContext(context.Background(), "correct horse battery"); !errors.Is(err, ErrHashBusy) {
		t.Fatalf("hash with the gate full: %v, want ErrHashBusy", err)
	}
	<-hashGate
	if _, err := HashPasswordContext(context.Background(), "correct horse battery"); err != nil || runs != 1 {
		t.Fatalf("hash with a free slot: err %v runs %d", err, runs)
	}
}

func TestHashVerify(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse battery", h) {
		t.Error("correct password rejected")
	}
	if VerifyPassword("wrong password!!", h) {
		t.Error("wrong password accepted")
	}
	if VerifyPassword("x", "garbage") {
		t.Error("garbage hash accepted")
	}
}

func TestVerifyPasswordRejectsExcessiveCost(t *testing.T) {
	encoded := "$argon2id$v=19$m=4294967295,t=3,p=4$MTIzNDU2Nzg5MGFiY2RlZg$MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY"
	if VerifyPassword("password", encoded) {
		t.Fatal("accepted hash with unsafe memory cost")
	}
}

func TestValidatePassword(t *testing.T) {
	for _, tc := range []struct {
		pw, email string
		want      error
	}{
		{"short", "", ErrWeakPassword},
		// ten bytes, four characters: length counts characters
		{"äöüß😀", "", ErrWeakPassword},
		{"long enough password", "", nil},
		{"1234567890", "", ErrCommonPassword},
		{"QwertyUiop", "", ErrCommonPassword},
		{"weebsync123", "", ErrCommonPassword},
		{"chisato@da.jp", "chisato@da.jp", ErrCommonPassword},
		{"Chisato2026!", "chisato@da.jp", ErrCommonPassword},
		{"chisato likes trains", "chisato@da.jp", nil},
	} {
		if err := ValidatePassword(tc.pw, tc.email); !errors.Is(err, tc.want) {
			t.Errorf("ValidatePassword(%q, %q) = %v, want %v", tc.pw, tc.email, err, tc.want)
		}
	}
}

func TestVerifyNormalisesUnicode(t *testing.T) {
	composed, decomposed := "kennwort-\u00e4bc", "kennwort-a\u0308bc"
	h, err := HashPassword(decomposed)
	if err != nil {
		t.Fatal(err)
	}
	if ok, legacy := VerifyPasswordLegacy(composed, h); !ok || legacy {
		t.Errorf("composed form against NFC hash: ok=%v legacy=%v", ok, legacy)
	}
	// a hash from before normalisation was taken over the raw bytes
	old := legacyHash(t, decomposed)
	if ok, legacy := VerifyPasswordLegacy(decomposed, old); !ok || !legacy {
		t.Errorf("raw form against pre-NFC hash: ok=%v legacy=%v", ok, legacy)
	}
}

// legacyHash builds a hash the way HashPassword did before NFC.
func legacyHash(t *testing.T, pw string) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}
