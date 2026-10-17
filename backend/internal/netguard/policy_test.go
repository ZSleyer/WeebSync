package netguard

import (
	"net"
	"testing"
)

func checkPolicy(t *testing.T, name string, deny func(net.IP) bool, denied, open []string) {
	t.Helper()
	for _, s := range denied {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("%s: bad test address %q", name, s)
		}
		if !deny(ip) {
			t.Errorf("%s must deny %s", name, s)
		}
	}
	for _, s := range open {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("%s: bad test address %q", name, s)
		}
		if deny(ip) {
			t.Errorf("%s must allow %s", name, s)
		}
	}
}

func TestClientPolicyTable(t *testing.T) {
	checkPolicy(t, "client", blocked,
		[]string{"0.0.0.0", "::", "::ffff:0.0.0.0", "0.0.0.1", "0.255.255.255", "169.254.169.254", "::ffff:169.254.169.254",
			"224.0.0.1", "224.0.1.1", "239.255.255.255", "255.255.255.255", "ff00::1", "ff05::2", "ffff::1", "fe80::1",
			"fd00:ec2::254"},
		[]string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.1", "192.168.0.1", "100.64.0.1", "fd00::1", "1.1.1.1",
			"2606:4700:4700::1111", "240.0.0.1", "198.18.0.1", "192.0.0.1", "fec0::1", "169.253.255.255", "223.255.255.255"})
}

func TestPublicPolicyTable(t *testing.T) {
	checkPolicy(t, "public", publicBlocked,
		[]string{"0.0.0.0", "0.0.0.1", "169.254.169.254", "127.0.0.1", "::1", "10.0.0.1", "192.168.1.1", "::ffff:192.168.1.1", "fc00::1",
			"255.255.255.254", "224.0.1.1", "ff05::2", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255",
			"240.0.0.1", "192.0.0.1", "192.0.0.255", "fec0::1", "feff::1", "::ffff:100.64.0.1"},
		[]string{"1.1.1.1", "172.15.255.255", "172.32.0.0", "11.0.0.0", "2606:4700:4700::1111", "::ffff:1.1.1.1", "fe00::1",
			"192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:db8::1", "100.63.255.255", "100.128.0.0", "198.17.255.255",
			"198.20.0.0", "192.0.1.1", "223.255.255.255"})
}

func TestEmbeddedIPv4IsJudgedAsIPv4(t *testing.T) {
	for name, deny := range map[string]func(net.IP) bool{"client": blocked, "public": publicBlocked} {
		checkPolicy(t, name, deny,
			[]string{"64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "::169.254.169.254", "::ffff:0:169.254.169.254", "2002:a9fe:a9fe::1",
				// Teredo stores the client address inverted: 169.254.169.254 is a9fe a9fe ^ ffff
				"2001:0:4136:e378:8000:63bf:5601:5601"},
			[]string{"64:ff9b::808:808", "2002:808:808::1", "::8.8.8.8"})
	}
	// a private or loopback target behind a gateway: only the public profile minds
	private := []string{"64:ff9b::a00:1", "2002:c0a8:101::1", "::192.168.1.1", "::ffff:0:10.1.2.3"}
	checkPolicy(t, "public", publicBlocked, private, nil)
	checkPolicy(t, "client", blocked, nil, append(private, "64:ff9b::7f00:1"))
}
