package remote

import (
	"errors"
	"os"
	"strconv"
	"testing"
)

// TestSFTPLive runs first contact, pinning and a listing against a real SSH
// server with the restricted algorithm set. Only when SFTP_TEST_HOST is set
// (with SFTP_TEST_PORT, SFTP_TEST_USER, SFTP_TEST_PASS); CI skips it.
func TestSFTPLive(t *testing.T) {
	host := os.Getenv("SFTP_TEST_HOST")
	if host == "" {
		t.Skip("SFTP_TEST_HOST not set")
	}
	port, _ := strconv.Atoi(os.Getenv("SFTP_TEST_PORT"))
	cfg := Config{Protocol: "sftp", Host: host, Port: port,
		Username: os.Getenv("SFTP_TEST_USER"), Password: os.Getenv("SFTP_TEST_PASS")}
	_, err := Dial(cfg)
	var hk *HostKeyError
	if !errors.As(err, &hk) || hk.Offered == "" {
		t.Fatalf("first contact: want a host key error with the offered key, got %v", err)
	}
	label, _ := KeyLabel(hk.Offered)
	t.Logf("offered %s", label)
	cfg.HostKey = hk.Offered
	c, err := Dial(cfg)
	if err != nil {
		t.Fatalf("dial with the pinned key: %v", err)
	}
	defer c.Close()
	if _, err := c.List("/"); err != nil {
		t.Fatalf("list: %v", err)
	}
	cfg.HostKey = "AAAAC3NzaC1lZDI1NTE5AAAAIHRoaXMgaXMgbm90IHRoZSBrZXkgeW91IHdhbnQhIQ=="
	if _, err := Dial(cfg); !errors.As(err, &hk) {
		t.Errorf("a wrong pinned key was accepted: %v", err)
	}
}
