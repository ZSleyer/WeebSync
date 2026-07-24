package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestKeyLabel(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.StdEncoding.EncodeToString(sshPub.Marshal())

	label, err := KeyLabel(b64)
	if err != nil {
		t.Fatalf("KeyLabel: %v", err)
	}
	if !strings.HasPrefix(label, "ssh-ed25519 SHA256:") {
		t.Errorf("label = %q, want ssh-ed25519 SHA256: prefix", label)
	}
	if label != "ssh-ed25519 "+ssh.FingerprintSHA256(sshPub) {
		t.Errorf("label = %q, fingerprint mismatch", label)
	}

	for _, bad := range []string{"", "not-base64!", base64.StdEncoding.EncodeToString([]byte("garbage"))} {
		if _, err := KeyLabel(bad); err == nil {
			t.Errorf("KeyLabel(%q): want error", bad)
		}
	}
}

func TestHostKeyErrorMessages(t *testing.T) {
	if e := (&HostKeyError{Offered: "x"}); !strings.Contains(e.Error(), "not trusted yet") {
		t.Errorf("first-contact message = %q", e.Error())
	}
	if e := (&HostKeyError{Offered: "x", Stored: "y"}); !strings.Contains(e.Error(), "mismatch") {
		t.Errorf("mismatch message = %q", e.Error())
	}
}
