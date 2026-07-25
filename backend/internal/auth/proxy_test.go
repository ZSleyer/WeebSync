package auth

import (
	"net/http"
	"testing"
)

// req builds a request that arrived from `from` carrying the given
// X-Forwarded-For, the way a proxy would have left it.
func req(from, xff string) *http.Request {
	r := &http.Request{Header: http.Header{}, RemoteAddr: from + ":51234"}
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return r
}

// restore puts the package back into its default state, since the config is
// process-wide.
func restore(t *testing.T) {
	t.Cleanup(func() { SetProxyConfig("", false) })
}

func TestClientIPIgnoresForwardedWithoutATrustedProxy(t *testing.T) {
	restore(t)
	SetProxyConfig("", false)
	// nothing is trusted, so a header anyone can set must not be read
	if got := ClientIP(req("203.0.113.7", "1.2.3.4")); got != "203.0.113.7" {
		t.Fatalf("got %q, want the peer address", got)
	}
}

func TestClientIPReadsForwardedFromAListedProxy(t *testing.T) {
	restore(t)
	SetProxyConfig("172.30.0.0/16", false)
	if got := ClientIP(req("172.30.33.9", "203.0.113.7")); got != "203.0.113.7" {
		t.Fatalf("got %q, want the forwarded client", got)
	}
	// same header, but from something that is not one of our proxies
	if got := ClientIP(req("198.51.100.4", "203.0.113.7")); got != "198.51.100.4" {
		t.Fatalf("got %q, want the peer address", got)
	}
}

// The regression this whole change exists for: reading the leftmost entry
// hands the caller whatever it wrote there.
func TestClientIPDoesNotBelieveAForgedPrefix(t *testing.T) {
	restore(t)
	SetProxyConfig("172.30.0.0/16", false)
	// the client sent "X-Forwarded-For: 9.9.9.9" and our proxy appended
	got := ClientIP(req("172.30.33.9", "9.9.9.9, 203.0.113.7"))
	if got != "203.0.113.7" {
		t.Fatalf("got %q, want the address our own proxy recorded", got)
	}
}

func TestClientIPSkipsOurOwnProxiesInTheChain(t *testing.T) {
	restore(t)
	SetProxyConfig("172.30.0.0/16, 10.8.0.0/16", false)
	got := ClientIP(req("172.30.33.9", "203.0.113.7, 10.8.0.2"))
	if got != "203.0.113.7" {
		t.Fatalf("got %q, want the first address that is not ours", got)
	}
}

func TestClientIPTrustAllTakesTheLastHop(t *testing.T) {
	restore(t)
	SetProxyConfig("true", false)
	// with no list there is nothing to skip, so the entry our peer appended
	// wins - not the one the caller could choose
	if got := ClientIP(req("172.30.33.9", "9.9.9.9, 203.0.113.7")); got != "203.0.113.7" {
		t.Fatalf("got %q, want the last hop", got)
	}
	// a single-entry header (a proxy that overwrites rather than appends)
	if got := ClientIP(req("172.30.33.9", "203.0.113.7")); got != "203.0.113.7" {
		t.Fatalf("got %q, want the forwarded client", got)
	}
	// no header at all
	if got := ClientIP(req("172.30.33.9", "")); got != "172.30.33.9" {
		t.Fatalf("got %q, want the peer address", got)
	}
}

func TestForceHTTPSAndForwardedProto(t *testing.T) {
	restore(t)

	SetProxyConfig("", true)
	if !IsHTTPS(req("203.0.113.7", "")) {
		t.Fatal("force-https must mark every request as https")
	}

	SetProxyConfig("172.30.0.0/16", false)
	r := req("172.30.33.9", "")
	r.Header.Set("X-Forwarded-Proto", "https")
	if !IsHTTPS(r) {
		t.Fatal("a trusted proxy's X-Forwarded-Proto must be believed")
	}

	// the same header straight from a client is worth nothing
	r = req("203.0.113.7", "")
	r.Header.Set("X-Forwarded-Proto", "https")
	if IsHTTPS(r) {
		t.Fatal("X-Forwarded-Proto from an untrusted peer must be ignored")
	}
}

func TestEnvWinsOverTheStoredSetting(t *testing.T) {
	restore(t)
	// the env values are captured at package init, so the test swaps the
	// captured copies rather than the environment
	saved, savedForce := envTrustedProxies, envForceHTTPS
	envTrustedProxies, envForceHTTPS = "10.0.0.0/8", "true"
	t.Cleanup(func() { envTrustedProxies, envForceHTTPS = saved, savedForce })

	// the UI tries to set something else; the environment has to win, because
	// that is what the locked field in the UI promises
	SetProxyConfig("192.168.0.0/16", false)
	if got := ClientIP(req("10.1.2.3", "203.0.113.7")); got != "203.0.113.7" {
		t.Fatalf("got %q, want the env-configured proxy to be trusted", got)
	}
	if got := ClientIP(req("192.168.1.1", "203.0.113.7")); got != "192.168.1.1" {
		t.Fatalf("got %q, want the stored value to be ignored", got)
	}
	if !IsHTTPS(req("203.0.113.7", "")) {
		t.Fatal("WEEBSYNC_FORCE_HTTPS must win over a stored false")
	}
}

func TestIPListIgnoresBadEntriesAndUnmapsV4(t *testing.T) {
	l := ParseIPList("10.0.0.0/8, nonsense, 192.168.1.5, 999.1.1.1/8")
	if !l.Contains("10.2.3.4") || !l.Contains("192.168.1.5") {
		t.Fatal("valid entries must still match")
	}
	if l.Contains("172.16.0.1") {
		t.Fatal("unlisted address must not match")
	}
	// a dual-stack listener reports IPv4 peers in this form
	if !l.Contains("::ffff:10.2.3.4") {
		t.Fatal("IPv4-mapped IPv6 must match the IPv4 network")
	}
}
