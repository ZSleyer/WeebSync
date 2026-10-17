package api

import (
	"bytes"
	"strings"
	"testing"
)

// Bytes from 248 up are dropped, not folded onto the first symbols.
func TestRandSymbolsRejectsBiasedBytes(t *testing.T) {
	src := bytes.NewReader([]byte{255, 248, 0, 247, 254, 31})
	got, err := randSymbols(src, 3)
	if err != nil {
		t.Fatal(err)
	}
	want := string([]byte{codeAlphabet[0], codeAlphabet[247%31], codeAlphabet[0]})
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if _, err := randSymbols(bytes.NewReader([]byte{255, 255}), 1); err == nil {
		t.Error("an exhausted source did not fail")
	}
}

func TestSecretShapes(t *testing.T) {
	c, err := recoveryCode()
	if err != nil || len(c) != 11 || c[5] != '-' {
		t.Fatalf("recovery code %q, %v", c, err)
	}
	tok := newSetupToken()
	if len(tok) != 24 || strings.Count(tok, "-") != 4 {
		t.Fatalf("setup token %q", tok)
	}
}
