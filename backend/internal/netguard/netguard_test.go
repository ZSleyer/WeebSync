package netguard

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAllowed(t *testing.T) {
	blocked := []string{
		"169.254.169.254",        // AWS/GCP IPv4 metadata
		"::ffff:169.254.169.254", // IPv4-mapped IPv6 - must not bypass
		"fd00:ec2::254",          // AWS IPv6 metadata
		"fe80::1",                // IPv6 link-local
	}
	for _, h := range blocked {
		if err := Allowed(h); err == nil {
			t.Errorf("Allowed(%q) = nil, want blocked", h)
		}
	}
	allowed := []string{
		"192.168.1.10",         // LAN
		"10.0.0.5",             // LAN
		"172.16.0.1",           // LAN
		"1.1.1.1",              // public
		"2606:4700:4700::1111", // public IPv6
	}
	for _, h := range allowed {
		if err := Allowed(h); err != nil {
			t.Errorf("Allowed(%q) = %v, want nil", h, err)
		}
	}
	if Allowed("") == nil {
		t.Error("Allowed(\"\") = nil, want error")
	}
}

func TestClientBlocksDirectDial(t *testing.T) {
	// dialing a metadata address directly must fail in DialContext
	c := Client(2 * time.Second)
	_, err := c.Get("http://169.254.169.254/latest/meta-data/")
	if err == nil {
		t.Fatal("Client dialed a blocked metadata address, want error")
	}
}

func TestClientBlocksRedirectToBlocked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer srv.Close()
	c := Client(2 * time.Second)
	if _, err := c.Get(srv.URL); err == nil {
		t.Fatal("Client followed a redirect to a blocked address, want error")
	}
}

func TestClientAllowsNormalHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := Client(2 * time.Second)
	resp, err := c.Get(srv.URL) // 127.0.0.1 is loopback, not blocked
	if err != nil {
		t.Fatalf("Client refused a normal loopback host: %v", err)
	}
	resp.Body.Close()
}
