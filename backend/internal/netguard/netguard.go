// Package netguard blocks outbound connections to addresses that are never a
// legitimate target for a user-supplied host: cloud-metadata and link-local.
// Private LAN and public internet ranges stay allowed — reaching local and
// remote SFTP/FTP servers (and a LAN OIDC provider) is the core feature.
package netguard

import (
	"fmt"
	"net"
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
