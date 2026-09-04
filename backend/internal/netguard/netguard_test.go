package netguard

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

func TestPublicAllowedBlocksLocalNetworks(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.1"} {
		if err := PublicAllowed(host); err == nil {
			t.Errorf("PublicAllowed(%q) = nil, want blocked", host)
		}
	}
	if err := PublicAllowed("1.1.1.1"); err != nil {
		t.Fatalf("PublicAllowed(public IP) = %v", err)
	}
}

func TestPublicClientBlocksHTTPSDowngrade(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "http://1.1.1.1/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := PublicClient(time.Second).CheckRedirect(req, nil); err == nil {
		t.Fatal("public client allowed a redirect to HTTP")
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

// stubDNS answers lookups from the list in order and keeps repeating the last
// entry; it reports how many lookups happened.
func stubDNS(t *testing.T, answers ...[]net.IP) *int {
	t.Helper()
	orig := lookupIP
	t.Cleanup(func() { lookupIP = orig })
	calls := 0
	lookupIP = func(context.Context, string) ([]net.IP, error) {
		calls++
		return answers[min(calls, len(answers))-1], nil
	}
	return &calls
}

func TestClientRefusesHostnameResolvingToBlocked(t *testing.T) {
	cases := []struct {
		name string
		c    *http.Client
		ip   string
	}{
		{"metadata", Client(time.Second), "169.254.169.254"},
		{"private for public client", PublicClient(time.Second), "10.0.0.1"},
	}
	for _, tc := range cases {
		calls := stubDNS(t, []net.IP{net.ParseIP(tc.ip)})
		_, err := tc.c.Get("http://x.test/")
		if err == nil || !strings.Contains(err.Error(), "blocked address") {
			t.Fatalf("%s: err=%v", tc.name, err)
		}
		if *calls != 1 {
			t.Fatalf("%s: %d lookups", tc.name, *calls)
		}
	}
}

// DNS rebinding: the IP that was checked is the IP that gets dialed, and a
// later answer pointing at a blocked address is refused, not silently dialed.
func TestClientDialsTheIPItChecked(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	stubDNS(t, []net.IP{net.IPv4(127, 0, 0, 1)}, []net.IP{net.ParseIP("169.254.169.254")})
	c := Client(2 * time.Second)
	resp, err := c.Get("http://rebind.test:" + port + "/")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("first request: %v", err)
	}
	resp.Body.Close()
	c.CloseIdleConnections()
	if _, err := c.Get("http://rebind.test:" + port + "/"); err == nil || !strings.Contains(err.Error(), "blocked address") {
		t.Fatalf("rebound request: err=%v", err)
	}
	if hits != 1 {
		t.Fatalf("server hit %d times", hits)
	}
}

func TestClientIgnoresProxyEnv(t *testing.T) {
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	accepted := make(chan struct{}, 8)
	go func() {
		for {
			conn, err := proxy.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			conn.Close()
		}
	}()
	t.Setenv("HTTP_PROXY", "http://"+proxy.Addr().String())
	t.Setenv("NO_PROXY", "")
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	req, _ := http.NewRequest(http.MethodGet, "http://direct.test:"+port+"/", nil)
	if u, _ := http.ProxyFromEnvironment(req); u == nil {
		t.Fatal("control: environment would not proxy this request")
	}
	stubDNS(t, []net.IP{net.IPv4(127, 0, 0, 1)})
	resp, err := Client(2 * time.Second).Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("direct request: %v", err)
	}
	resp.Body.Close()
	if len(accepted) != 0 {
		t.Fatal("request went through the proxy")
	}
}

func TestSafeDial(t *testing.T) {
	stubDNS(t, []net.IP{net.ParseIP("169.254.169.254")})
	if _, err := SafeDial(context.Background(), "tcp", "meta.test", 80, time.Second); err == nil || !strings.Contains(err.Error(), "blocked address") {
		t.Fatalf("blocked host dialed: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	stubDNS(t, []net.IP{net.IPv4(127, 0, 0, 1)})
	conn, err := SafeDial(context.Background(), "tcp", "local.test", p, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
