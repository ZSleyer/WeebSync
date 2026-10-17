// Package netguard blocks outbound connections to addresses that are never a
// legitimate target for a user-supplied host: cloud-metadata and link-local.
// Private LAN and public internet ranges stay allowed - reaching local and
// remote SFTP/FTP servers (and a LAN OIDC provider) is the core feature.
package netguard

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// awsMetadataV6 is the IPv6 cloud-metadata address (AWS). Link-local (IPv4
// 169.254.0.0/16 incl. 169.254.169.254 and IPv6 fe80::/10) is covered by
// IsLinkLocalUnicast; this one sits in the ULA range and needs an explicit check.
var awsMetadataV6 = net.ParseIP("fd00:ec2::254")

// lookupIP is the single resolve seam; tests swap it, production always asks
// the system resolver.
var lookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

// blocked reports whether a resolved IP must never be dialed. Loopback and
// private LAN stay allowed on purpose - a self-hosted setup legitimately points
// at SFTP/Plex/OIDC on the same host or LAN. Refused everywhere: all of
// 0.0.0.0/8 (on Linux it reaches the local host), :: , link-local, multicast
// (one-to-many, never a TCP target), the IPv4 broadcast address and the AWS
// IPv6 metadata address. An IPv4 address a gateway or tunnel embeds in an IPv6
// one is judged as the IPv4 address it reaches.
func blocked(ip net.IP) bool { return denyEmbedded(ip, blockedAddr) }

// publicBlocked adds everything that is not a public destination: loopback,
// private LAN, CGNAT, benchmarking, reserved and IETF-assignment IPv4 ranges
// and the deprecated IPv6 site-local range.
func publicBlocked(ip net.IP) bool { return denyEmbedded(ip, publicBlockedAddr) }

func blockedAddr(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		return ip4[0] == 0 || ip4.IsLinkLocalUnicast() || ip4.IsMulticast() || ip4.Equal(net.IPv4bcast)
	}
	return ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.Equal(awsMetadataV6)
}

func publicBlockedAddr(ip net.IP) bool {
	if blockedAddr(ip) || ip.IsLoopback() || ip.IsPrivate() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		for _, n := range publicBlockedV4 {
			if n.Contains(ip4) {
				return true
			}
		}
		return false
	}
	// fec0::/10, deprecated site-local
	return len(ip) == net.IPv6len && ip[0] == 0xfe && ip[1]&0xc0 == 0xc0
}

// publicBlockedV4 are the IPv4 ranges besides RFC 1918 and loopback that no
// public service lives in.
var publicBlockedV4 = []*net.IPNet{
	cgnat,
	{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)},
	{IP: net.IPv4(240, 0, 0, 0), Mask: net.CIDRMask(4, 32)},
	{IP: net.IPv4(192, 0, 0, 0), Mask: net.CIDRMask(24, 32)},
}

func denyEmbedded(ip net.IP, deny func(net.IP) bool) bool {
	if deny(ip) {
		return true
	}
	e := embeddedV4(ip)
	return e != nil && deny(e)
}

// embeddedV4 returns the IPv4 address a gateway or tunnel embeds in an IPv6
// one, nil for anything else. On a NAT64 network 64:ff9b::a9fe:a9fe reaches
// 169.254.169.254 all the same.
func embeddedV4(ip net.IP) net.IP {
	if ip.To4() != nil || len(ip) != net.IPv6len {
		return nil
	}
	seg := func(i int) uint16 { return uint16(ip[2*i])<<8 | uint16(ip[2*i+1]) }
	v4 := func(hi, lo uint16) net.IP { return net.IPv4(byte(hi>>8), byte(hi), byte(lo>>8), byte(lo)) }
	allZero := func(from, to int) bool {
		for i := from; i < to; i++ {
			if seg(i) != 0 {
				return false
			}
		}
		return true
	}
	switch {
	// ::a.b.c.d, IPv4-compatible (deprecated); ::1 is not 0.0.0.1
	case allZero(0, 6) && seg(6) != 0:
		return v4(seg(6), seg(7))
	// 64:ff9b::/96, NAT64
	case seg(0) == 0x64 && seg(1) == 0xff9b && allZero(2, 6):
		return v4(seg(6), seg(7))
	// ::ffff:0:a.b.c.d, SIIT
	case allZero(0, 4) && seg(4) == 0xffff && seg(5) == 0:
		return v4(seg(6), seg(7))
	// 2002:a.b.c.d::/16, 6to4
	case seg(0) == 0x2002:
		return v4(seg(1), seg(2))
	// 2001:0::/32, Teredo, whose client address is stored inverted
	case seg(0) == 0x2001 && seg(1) == 0:
		return v4(^seg(6), ^seg(7))
	}
	return nil
}

// SafeDial resolves host, rejects blocked IPs, and dials the exact verified IP
// (no second resolve, so no DNS-rebinding TOCTOU). For raw-TCP callers such as
// the SSH transport that cannot use the HTTP Client above.
func SafeDial(ctx context.Context, network, host string, port int, timeout time.Duration) (net.Conn, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		resolved, err := lookupIP(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", host, err)
		}
		ips = resolved
	}
	d := &net.Dialer{Timeout: timeout}
	var lastErr error = fmt.Errorf("no dialable address for %s", host)
	for _, ip := range ips {
		if blocked(ip) {
			lastErr = fmt.Errorf("host %s resolves to blocked address %s", host, ip)
			continue
		}
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// Allowed resolves host (an IP or hostname) and rejects it if any resolved
// address is a metadata/link-local target. Every resolved IP is checked so a
// hostname cannot smuggle a blocked address past the guard (DNS rebinding).
func Allowed(host string) error {
	return allowed(host, blocked)
}

// PublicAllowed rejects every non-public destination. It is for callbacks such
// as Web Push endpoints, where LAN access is never legitimate.
func PublicAllowed(host string) error {
	return allowed(host, publicBlocked)
}

func allowed(host string, deny func(net.IP) bool) error {
	if host == "" {
		return fmt.Errorf("empty host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if deny(ip) {
			return fmt.Errorf("host %s is a blocked address", host)
		}
		return nil
	}
	ips, err := lookupIP(context.Background(), host)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", host, err)
	}
	for _, ip := range ips {
		if deny(ip) {
			return fmt.Errorf("host %s resolves to blocked address %s", host, ip)
		}
	}
	return nil
}

// Client returns an http.Client that enforces the guard at connection time, not
// just as a pre-flight lexical check. Its DialContext resolves the host and
// dials the exact allowed IP it verified (closing the DNS-rebinding TOCTOU), and
// every redirect hop is re-checked - so a target that 302s to 169.254.169.254 or
// rebinds to a blocked address is refused mid-flight. Use it for every outbound
// fetch to a host that is (even indirectly) user-influenced.
func Client(timeout time.Duration) *http.Client {
	return client(timeout, blocked, false)
}

// PublicClient is Client with loopback and private networks blocked too.
func PublicClient(timeout time.Duration) *http.Client {
	return client(timeout, publicBlocked, true)
}

// PublicFetchClient is PublicClient without the HTTPS requirement, for
// reading arbitrary web pages: an http:// page is still a page, but a LAN or
// loopback target is never one the caller may name.
func PublicFetchClient(timeout time.Duration) *http.Client {
	return client(timeout, publicBlocked, false)
}

// secretHeaders are dropped when a redirect leaves the origin a request
// started at.
var secretHeaders = []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Plex-Token", "X-Api-Key", "Api-Key"}

func client(timeout time.Duration, deny func(net.IP) bool, httpsOnly bool) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		// A proxy would make DialContext validate the proxy rather than the
		// requested destination and bypass this guard.
		Proxy: nil,
		// system roots (plus SSL_CERT_FILE / SSL_CERT_DIR for a private CA),
		// hostname checked, nothing older than TLS 1.2
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			var ips []net.IP
			if ip := net.ParseIP(host); ip != nil {
				ips = []net.IP{ip}
			} else {
				resolved, err := lookupIP(ctx, host)
				if err != nil {
					return nil, err
				}
				ips = resolved
			}
			var lastErr error = fmt.Errorf("no dialable address for %s", host)
			for _, ip := range ips {
				if deny(ip) {
					lastErr = fmt.Errorf("host %s resolves to blocked address %s", host, ip)
					continue
				}
				// dial the exact IP we just checked - no second resolve, no TOCTOU
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after 10 redirects")
			}
			if httpsOnly && req.URL.Scheme != "https" {
				return fmt.Errorf("redirect to non-HTTPS URL blocked")
			}
			// a request that began encrypted stays encrypted: a 3xx to http://
			// would carry its token in clear text
			if len(via) > 0 && via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
				return fmt.Errorf("redirect from HTTPS to %s blocked", req.URL.Scheme)
			}
			// credentials are for the origin they were meant for. Go drops
			// Authorization and Cookie only for another domain and never a
			// custom header like X-Plex-Token, so a redirect to another host
			// (or port, or a subdomain) would hand them over
			if len(via) > 0 && (req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host) {
				for _, h := range secretHeaders {
					req.Header.Del(h)
				}
			}
			return allowed(req.URL.Hostname(), deny)
		},
	}
}

// LocalOnly reports whether host resolves only to loopback or private
// addresses (RFC 1918, IPv6 ULA): traffic that never leaves the operator's
// own network, where an http:// URL carrying a token may be acceptable.
func LocalOnly(host string) bool {
	var ips []net.IP
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		ips = []net.IP{ip}
	} else {
		resolved, err := lookupIP(context.Background(), host)
		if err != nil || len(resolved) == 0 {
			return false
		}
		ips = resolved
	}
	for _, ip := range ips {
		if !ip.IsLoopback() && !ip.IsPrivate() && !cgnat.Contains(ip) {
			return false
		}
	}
	return true
}

// cgnat is 100.64.0.0/10 (RFC 6598): carrier-grade NAT, and the range
// overlay networks like Tailscale hand out inside one's own tailnet.
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
