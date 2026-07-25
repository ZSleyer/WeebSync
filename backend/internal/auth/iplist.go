package auth

import (
	"net/netip"
	"strings"
)

// IPList is a parsed allowlist of addresses and networks - the shape both the
// trusted-proxy list and the rate-limit bypass ("trusted networks") are given
// in: a comma-separated mix of bare IPs and CIDRs, e.g.
// "172.30.0.0/16, 10.0.0.1".
type IPList []netip.Prefix

// ParseIPList parses the setting, skipping entries it cannot read. Validation
// belongs at the API boundary, where a typo can still be reported to whoever
// made it; here a bad entry must not take the good ones down with it.
func ParseIPList(csv string) IPList {
	var out IPList
	for _, part := range strings.Split(csv, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "/") {
			if p, err := netip.ParsePrefix(part); err == nil {
				out = append(out, p.Masked())
			}
			continue
		}
		if a, err := netip.ParseAddr(part); err == nil {
			out = append(out, netip.PrefixFrom(a, a.BitLen()))
		}
	}
	return out
}

// Contains reports whether ip falls inside the list. An IPv4 address written
// as an IPv4-mapped IPv6 one (::ffff:10.0.0.1, which is how a dual-stack
// listener reports it) is unmapped first, so a plain 10.0.0.0/8 entry matches
// it as the operator expects.
func (l IPList) Contains(ip string) bool {
	if len(l) == 0 {
		return false
	}
	a, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	a = a.Unmap()
	for _, p := range l {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
