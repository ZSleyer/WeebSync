package auth

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

var (
	dummyOnce sync.Once
	dummyHash string
)

// DummyVerify burns the same argon2 work as a real VerifyPassword so the login
// path costs the same time whether or not the account exists - closing the
// timing side channel that would otherwise reveal which emails are registered.
func DummyVerify(password string) {
	dummyOnce.Do(func() { dummyHash, _ = HashPassword("weebsync-nonexistent-account") })
	if dummyHash != "" {
		_ = VerifyPassword(password, dummyHash)
	}
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
	password = norm.NFC.String(password)
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against an encoded hash. Hashes from before
// NFC normalisation were taken over the bytes as typed, so a miss on the NFC
// form tries those once more.
func VerifyPassword(password, encoded string) bool {
	ok, _ := verifyPassword(password, encoded)
	return ok
}

// VerifyPasswordLegacy is VerifyPassword that also reports whether only the
// unnormalised form matched, in which case the stored hash should be renewed.
func VerifyPasswordLegacy(password, encoded string) (ok, legacy bool) {
	return verifyPassword(password, encoded)
}

func verifyPassword(password, encoded string) (ok, legacy bool) {
	nfc := norm.NFC.String(password)
	if verifyEncoded(nfc, encoded) {
		return true, false
	}
	if nfc != password && verifyEncoded(password, encoded) {
		return true, true
	}
	return false, false
}

func verifyEncoded(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != fmt.Sprintf("v=%d", argon2.Version) {
		return false
	}
	var mem, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &time, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	if mem < 8*1024 || mem > 256*1024 || time < 1 || time > 10 || threads < 1 || threads > 16 ||
		len(salt) < 8 || len(salt) > 64 || len(want) < 16 || len(want) > 64 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, time, mem, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
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
