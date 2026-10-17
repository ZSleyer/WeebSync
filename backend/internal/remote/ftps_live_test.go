package remote

import (
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestFTPSLive lists and reads through a real FTPS server that requires TLS
// on the data channel, so a listing or download in clear text fails. It runs
// only when FTPS_TEST_HOST is set (with FTPS_TEST_PORT, FTPS_TEST_USER,
// FTPS_TEST_PASS, FTPS_TEST_FILE holding the expected file content, and
// SSL_CERT_FILE trusting the server's certificate); CI skips it.
func TestFTPSLive(t *testing.T) {
	host := os.Getenv("FTPS_TEST_HOST")
	if host == "" {
		t.Skip("FTPS_TEST_HOST not set")
	}
	port, _ := strconv.Atoi(os.Getenv("FTPS_TEST_PORT"))
	cfg := Config{Protocol: "ftps", Host: host, Port: port,
		Username: os.Getenv("FTPS_TEST_USER"), Password: os.Getenv("FTPS_TEST_PASS")}
	// FTPS_TEST_IMPLICIT=1 targets an implicit-TLS server on a port other than 990
	dial := Dial
	if os.Getenv("FTPS_TEST_IMPLICIT") != "" {
		dial = func(cfg Config) (Client, error) { return dialFTPTLS(cfg, nil, true) }
	}
	c, err := dial(cfg)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	entries, err := c.List("/")
	if err != nil {
		t.Fatalf("list over the protected data channel: %v", err)
	}
	var name string
	for _, e := range entries {
		if !e.IsDir {
			name = e.Name
		}
	}
	if name == "" {
		t.Fatalf("no file listed: %+v", entries)
	}
	r, err := c.Open("/"+name, 0)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got, err := io.ReadAll(r)
	r.Close()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := os.Getenv("FTPS_TEST_FILE"); strings.TrimSpace(string(got)) != want {
		t.Errorf("content %q, want %q", got, want)
	}
}
