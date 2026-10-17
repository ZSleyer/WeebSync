package push

import (
	"testing"
	"time"
)

// A stored private key that is not the public key's pair is refused before
// signing: the push service would reject the token after the round trip.
func TestVapidRefusesMismatchedPair(t *testing.T) {
	priv, _, err := generateKeys()
	if err != nil {
		t.Fatal(err)
	}
	_, otherPub, err := generateKeys()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	if _, err := vapid("https://push.example.net/x", "mailto:ops@example.com", otherPub, priv, now); err == nil {
		t.Fatal("signed with a private key that does not match the public key")
	}
	if _, err := vapid("https://push.example.net/x", "mailto:ops@example.com", "not a key", priv, now); err == nil {
		t.Fatal("signed with an undecodable public key")
	}
}
