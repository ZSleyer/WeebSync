package netguard

import "testing"

func TestAllowed(t *testing.T) {
	blocked := []string{
		"169.254.169.254",        // AWS/GCP IPv4 metadata
		"::ffff:169.254.169.254", // IPv4-mapped IPv6 — must not bypass
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
