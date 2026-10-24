package remote

import (
	"errors"
	"testing"
)

// A host netguard refuses is a setting to change, not a hiccup: both dial
// paths (a direct Dial and the pool's DialSSH) mark it ErrBlockedHost so the
// queue does not retry it.
func TestBlockedHostIsMarked(t *testing.T) {
	cfg := Config{Protocol: "sftp", Host: "169.254.169.254", Port: 22, Username: "u", Password: "p"}
	if _, err := Dial(cfg); !errors.Is(err, ErrBlockedHost) {
		t.Errorf("Dial to a metadata address: %v, want ErrBlockedHost", err)
	}
	if _, err := DialSSH(cfg); !errors.Is(err, ErrBlockedHost) {
		t.Errorf("DialSSH to a metadata address: %v, want ErrBlockedHost", err)
	}
	cfg.Protocol = "ftps"
	if _, err := Dial(cfg); !errors.Is(err, ErrBlockedHost) {
		t.Errorf("FTPS Dial to a metadata address: %v, want ErrBlockedHost", err)
	}
}
