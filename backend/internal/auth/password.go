package auth

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

// dummyHash is a well-formed hash with the real cost parameters that no
// password matches (its key is all zeros). Checking against it costs what a
// real check costs. It is written out rather than hashed, so it exists from
// the start and nothing - not even a full hashing gate on the first unknown
// address - can leave it empty and turn the dummy check into a no-op.
var dummyHash = fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
	argon2.Version, argonMemory, argonTime, argonThreads,
	base64.RawStdEncoding.EncodeToString([]byte("weebsync-dummy-s")),
	base64.RawStdEncoding.EncodeToString(make([]byte, argonKeyLen)))

// DummyVerify burns the same argon2 work as a real VerifyPassword so the login
// path costs the same time whether or not the account exists - closing the
// timing side channel that would otherwise reveal which emails are registered.
func DummyVerify(password string) {
	_ = DummyVerifyContext(context.Background(), password)
}

// DummyVerifyContext is DummyVerify that gives up like VerifyPasswordContext
// does when no hashing slot frees up, so an unknown address answers "busy"
// exactly when a known one would.
func DummyVerifyContext(ctx context.Context, password string) error {
	_, err := VerifyPasswordContext(ctx, password, dummyHash)
	return err
}

// Every argon2id run holds argonMemory (64 MiB) until it returns. Without a
// bound, parallel sign-ins from enough addresses add up to more memory than a
// small host has, and the OOM killer takes the whole process. The gate caps
// how many run at once; a caller that cannot get a slot within hashWaitMax (or
// before its request ends) gets ErrHashBusy instead of queueing on.
var (
	hashGate    = make(chan struct{}, min(max(runtime.GOMAXPROCS(0), 1), 4))
	hashWaitMax = 5 * time.Second
	// argonIDKey is argon2.IDKey; tests swap it to watch the gate
	argonIDKey = argon2.IDKey
)

// ErrHashBusy means every password hashing slot stayed taken: the server is
// overloaded, the caller should try again shortly.
var ErrHashBusy = errors.New("password hashing is busy, try again")

// idKey runs argon2id once a slot of the gate is free.
func idKey(ctx context.Context, password, salt []byte, iter, memory uint32, threads uint8, keyLen uint32) ([]byte, error) {
	// a request that is already gone must not take a free slot: select
	// would pick between the two at random
	if ctx.Err() != nil {
		return nil, ErrHashBusy
	}
	select {
	case hashGate <- struct{}{}:
	default:
		t := time.NewTimer(hashWaitMax)
		defer t.Stop()
		select {
		case hashGate <- struct{}{}:
		case <-ctx.Done():
			return nil, ErrHashBusy
		case <-t.C:
			return nil, ErrHashBusy
		}
	}
	defer func() { <-hashGate }()
	return argonIDKey(password, salt, iter, memory, threads, keyLen), nil
}

// argon2id parameters per OWASP recommendation (m=64MiB, t=3, p=4).
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashPassword hashes the NFC form of password, so the same characters typed
// on another keyboard (a precomposed "ä" or "a" plus a combining mark) still
// match.
func HashPassword(password string) (string, error) {
	return HashPasswordContext(context.Background(), password)
}

// HashPasswordContext is HashPassword for a request: ErrHashBusy when no
// hashing slot frees up in time.
func HashPasswordContext(ctx context.Context, password string) (string, error) {
	password = norm.NFC.String(password)
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := idKey(ctx, []byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against an encoded hash. Hashes from before
// NFC normalisation were taken over the bytes as typed, so a miss on the NFC
// form tries those once more.
func VerifyPassword(password, encoded string) bool {
	ok, _, _ := verifyPassword(context.Background(), password, encoded)
	return ok
}

// VerifyPasswordContext is VerifyPassword for a request: ErrHashBusy when no
// hashing slot frees up in time, which says nothing about the password.
func VerifyPasswordContext(ctx context.Context, password, encoded string) (bool, error) {
	ok, _, err := verifyPassword(ctx, password, encoded)
	return ok, err
}

// VerifyPasswordLegacy is VerifyPassword that also reports whether only the
// unnormalised form matched, in which case the stored hash should be renewed.
func VerifyPasswordLegacy(password, encoded string) (ok, legacy bool) {
	ok, legacy, _ = verifyPassword(context.Background(), password, encoded)
	return ok, legacy
}

// VerifyPasswordLegacyContext is VerifyPasswordLegacy for a request, see
// VerifyPasswordContext.
func VerifyPasswordLegacyContext(ctx context.Context, password, encoded string) (ok, legacy bool, err error) {
	return verifyPassword(ctx, password, encoded)
}

func verifyPassword(ctx context.Context, password, encoded string) (ok, legacy bool, err error) {
	nfc := norm.NFC.String(password)
	if ok, err := verifyEncoded(ctx, nfc, encoded); ok || err != nil {
		return ok, false, err
	}
	if nfc != password {
		ok, err := verifyEncoded(ctx, password, encoded)
		return ok, ok, err
	}
	return false, false, nil
}

func verifyEncoded(ctx context.Context, password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != fmt.Sprintf("v=%d", argon2.Version) {
		return false, nil
	}
	var mem, iter uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &iter, &threads); err != nil {
		return false, nil
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, nil
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, nil
	}
	if mem < 8*1024 || mem > 256*1024 || iter < 1 || iter > 10 || threads < 1 || threads > 16 ||
		len(salt) < 8 || len(salt) > 64 || len(want) < 16 || len(want) > 64 {
		return false, nil
	}
	got, err := idKey(ctx, []byte(password), salt, iter, mem, threads, uint32(len(want)))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

var (
	ErrWeakPassword   = errors.New("password must be at least 10 characters")
	ErrCommonPassword = errors.New("password is too common or easy to guess")
)

// common-passwords.txt: the entries of at least 10 characters from the NCSC
// list of the 100,000 most used passwords (SecLists, MIT), lower-cased.
// Anything shorter is refused by length already.
//
//go:embed common-passwords.txt
var commonPasswordsTxt string

var commonPasswords = sync.OnceValue(func() map[string]struct{} {
	m := make(map[string]struct{}, 10000)
	sc := bufio.NewScanner(strings.NewReader(commonPasswordsTxt))
	for sc.Scan() {
		if w := strings.TrimSpace(sc.Text()); w != "" {
			m[w] = struct{}{}
		}
	}
	return m
})

// ValidatePassword checks a new password for the account with the given email
// ("" when unknown). Length counts characters, not bytes (NIST 800-63B-4
// 3.1.1.2). Refused as well: passwords from the breach corpus, and ones built
// from the account's own address or the app's name.
func ValidatePassword(p, email string) error {
	p = norm.NFC.String(p)
	if utf8.RuneCountInString(p) < 10 {
		return ErrWeakPassword
	}
	low := strings.ToLower(p)
	if _, ok := commonPasswords()[low]; ok {
		return ErrCommonPassword
	}
	// "weebsync2026!" or the mailbox name with a suffix is the first thing a
	// targeted guess tries
	stripped := strings.TrimRightFunc(low, func(r rune) bool { return !('a' <= r && r <= 'z') })
	for _, w := range contextWords(email) {
		if low == w || stripped == w || strings.Contains(low, w) && utf8.RuneCountInString(low)-utf8.RuneCountInString(w) < 4 {
			return ErrCommonPassword
		}
	}
	return nil
}

func contextWords(email string) []string {
	words := []string{"weebsync"}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return words
	}
	words = append(words, email)
	if local, _, ok := strings.Cut(email, "@"); ok && utf8.RuneCountInString(local) >= 4 {
		words = append(words, local)
	}
	return words
}
