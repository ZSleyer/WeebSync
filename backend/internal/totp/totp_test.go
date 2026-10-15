package totp

import (
	"encoding/base32"
	"net/url"
	"testing"
	"time"
)

// RFC 6238 appendix B, the SHA1 rows, cut to the 6 digits authenticator apps
// show; the 8-digit values end in these.
func TestRFC6238Vectors(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	for ts, want := range map[int64]string{
		59: "287082", 1111111109: "081804", 1111111111: "050471",
		1234567890: "005924", 2000000000: "279037", 20000000000: "353130",
	} {
		if got, err := Code(secret, time.Unix(ts, 0)); err != nil || got != want {
			t.Errorf("t=%d: got %s, want %s (err %v)", ts, got, want, err)
		}
	}
}

// RFC 4226 appendix D, the HOTP layer on its own.
func TestRFC4226Vectors(t *testing.T) {
	want := []string{"755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"}
	for i, w := range want {
		if got := hotp([]byte("12345678901234567890"), uint64(i)); got != w {
			t.Errorf("counter %d: got %s, want %s", i, got, w)
		}
	}
}

func TestValidWindow(t *testing.T) {
	sec, _, err := New("WeebSync", "chisato@da.jp")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_015, 0)
	code, _ := Code(sec, now)
	for d, want := range map[time.Duration]bool{0: true, 30 * time.Second: true, -30 * time.Second: true, 61 * time.Second: false, -61 * time.Second: false} {
		if got := Valid(code, sec, now.Add(d)); got != want {
			t.Errorf("offset %v: valid = %v, want %v", d, got, want)
		}
	}
	if Valid("12345", sec, now) || Valid("abcdef", sec, now) || Valid(code, "not base32!", now) {
		t.Error("malformed input accepted")
	}
}

// Secrets stored by earlier releases are unpadded base32 of 20 bytes; some
// apps hand them back lower-case or with padding.
func TestSecretSpellings(t *testing.T) {
	sec, _, _ := New("WeebSync", "chisato@da.jp")
	now := time.Now()
	want, _ := Code(sec, now)
	for _, s := range []string{sec, " " + sec + " ", sec + "====", toLower(sec)} {
		if got, err := Code(s, now); err != nil || got != want {
			t.Errorf("%q: got %s err %v", s, got, err)
		}
	}
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func TestNewURI(t *testing.T) {
	sec, uri, err := New("WeebSync", "chisato@da.jp")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme != "otpauth" || u.Host != "totp" || u.Path != "/WeebSync:chisato@da.jp" ||
		q.Get("secret") != sec || q.Get("issuer") != "WeebSync" || q.Get("period") != "30" || q.Get("digits") != "6" {
		t.Fatalf("uri %s", uri)
	}
	if raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(sec); err != nil || len(raw) != 20 {
		t.Fatalf("secret %q decodes to %d bytes, %v", sec, len(raw), err)
	}
}
