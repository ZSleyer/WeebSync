// Package netguard blocks outbound connections to addresses that are never a
// legitimate target for a user-supplied host: cloud-metadata and link-local.
// Private LAN and public internet ranges stay allowed — reaching local and
// remote SFTP/FTP servers (and a LAN OIDC provider) is the core feature.
package netguard

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

// awsMetadataV6 is the IPv6 cloud-metadata address (AWS). Link-local (IPv4
// 169.254.0.0/16 incl. 169.254.169.254 and IPv6 fe80::/10) is covered by
// IsLinkLocalUnicast; this one sits in the ULA range and needs an explicit check.
var awsMetadataV6 = net.ParseIP("fd00:ec2::254")

// blocked reports whether a resolved IP must never be dialed.
func blocked(ip net.IP) bool {
	return ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.Equal(awsMetadataV6)
}

// Allowed resolves host (an IP or hostname) and rejects it if any resolved
// address is a metadata/link-local target. Every resolved IP is checked so a
// hostname cannot smuggle a blocked address past the guard (DNS rebinding).
func Allowed(host string) error {
	if host == "" {
		return fmt.Errorf("empty host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if blocked(ip) {
			return fmt.Errorf("host %s is a blocked address", host)
		}
		return nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", host, err)
	}
	for _, ip := range ips {
		if blocked(ip) {
			return fmt.Errorf("host %s resolves to blocked address %s", host, ip)
		}
	}
	return nil
}

// Client returns an http.Client that enforces the guard at connection time, not
// just as a pre-flight lexical check. Its DialContext resolves the host and
// dials the exact allowed IP it verified (closing the DNS-rebinding TOCTOU), and
// every redirect hop is re-checked — so a target that 302s to 169.254.169.254 or
// rebinds to a blocked address is refused mid-flight. Use it for every outbound
// fetch to a host that is (even indirectly) user-influenced.
func Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			var ips []net.IP
			if ip := net.ParseIP(host); ip != nil {
				ips = []net.IP{ip}
			} else {
				resolved, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
				if err != nil {
					return nil, err
				}
				ips = resolved
			}
			var lastErr error = fmt.Errorf("no dialable address for %s", host)
			for _, ip := range ips {
				if blocked(ip) {
					lastErr = fmt.Errorf("host %s resolves to blocked address %s", host, ip)
					continue
				}
				// dial the exact IP we just checked — no second resolve, no TOCTOU
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
			return Allowed(req.URL.Hostname())
		},
	}
}
