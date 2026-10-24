// Package totp implements time-based one-time passwords as authenticator apps
// expect them: RFC 6238 over RFC 4226 HOTP with HMAC-SHA1, 30-second steps
// and 6 digits.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238's default, the only one every authenticator app speaks
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const step = 30 // seconds

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// hotp is RFC 4226: HMAC-SHA1 over the counter, dynamic truncation, 6 digits.
func hotp(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	h := hmac.New(sha1.New, key)
	h.Write(msg[:])
	sum := h.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1_000_000)
}

// Code is the code for secret (base32, as the authenticator app holds it) at t.
func Code(secret string, t time.Time) (string, error) {
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimRight(strings.TrimSpace(secret), "=")))
	if err != nil {
		return "", err
	}
	return hotp(key, uint64(t.Unix())/step), nil
}

// Valid reports whether code matches at now or one step either side: phone
// clocks drift, and a code typed at the end of its step arrives in the next.
func Valid(code, secret string, now time.Time) bool {
	_, ok := Match(code, secret, now)
	return ok
}

// Match is Valid that also returns the time step (counter) the code belongs
// to. RFC 6238 §5.2: a verifier must not accept a code a second time, and
// with three steps in the window only "a later step than the last accepted
// one" rules that out; remembering the last code alone does not.
func Match(code, secret string, now time.Time) (uint64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	var matched uint64
	ok := 0
	for _, d := range []time.Duration{-step * time.Second, 0, step * time.Second} {
		t := now.Add(d)
		if c, err := Code(secret, t); err == nil && subtle.ConstantTimeCompare([]byte(c), []byte(code)) == 1 {
			// the latest step wins should two steps share a code
			ok, matched = 1, uint64(t.Unix())/step
		}
	}
	return matched, ok == 1
}

// New makes a 160-bit secret and the otpauth:// URL an authenticator app
// scans: "Issuer:account" as label, the issuer repeated as a parameter.
func New(issuer, account string) (secret, uri string, err error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret = b32.EncodeToString(raw)
	q := url.Values{"secret": {secret}, "issuer": {issuer}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}
	u := url.URL{Scheme: "otpauth", Host: "totp", Path: "/" + issuer + ":" + account, RawQuery: q.Encode()}
	return secret, u.String(), nil
}
