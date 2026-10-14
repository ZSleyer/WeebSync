package auth

import (
	"encoding/base64"
	"errors"
	"fmt"
	"testing"

	"golang.org/x/crypto/argon2"
)

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
