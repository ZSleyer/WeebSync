package api

import (
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// SecurityCheck is one finding of the instance's security review: what is
// not set up as well as it could be, and how bad that is. The UI words it
// from ID; Count and Detail fill in what the words need.
type SecurityCheck struct {
	ID string `json:"id"`
	// "risk": fix it before exposing the instance; "warn": should be fixed;
	// "info": worth knowing; "ok": checked and fine
	Level  string `json:"level" enums:"risk,warn,info,ok"`
	Count  int    `json:"count,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// handleSecurityCheck reviews how the instance is set up.
//
// @Summary      Security review
// @Description  Lists what about the instance's setup weakens it, worst first, with the checks that passed (admin only). Judged partly from this very request: the transport and proxy findings describe the way the admin reached the instance.
// @Tags         Admin
// @Produce      json
// @Success      200  {array}   SecurityCheck
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/security-check [get]
func (s *Server) handleSecurityCheck(w http.ResponseWriter, r *http.Request) {
	var out []SecurityCheck
	add := func(id, level string, count int, detail string) {
		out = append(out, SecurityCheck{ID: id, Level: level, Count: count, Detail: detail})
	}
	pass := func(id string) { add(id, "ok", 0, "") }

	// ---- transport, judged from this request
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remote = r.RemoteAddr
	}
	local := isLoopbackHost(remote)
	switch {
	case auth.IsHTTPS(r):
		pass("https")
	case local:
		add("https", "info", 0, "")
	default:
		add("https", "risk", 0, "")
	}
	// a proxy in front whose forwarded headers are not believed: every
	// client shares the proxy's address, rate limits included
	if r.Header.Get("X-Forwarded-For") != "" && auth.ClientIP(r) == remote {
		add("proxy_untrusted", "risk", 0, remote)
	}
	if v := strings.TrimSpace(db.SettingOrEnv(s.DB, "trusted_proxies", "WEEBSYNC_TRUSTED_PROXY")); truthySetting(v) {
		add("proxy_trust_all", "warn", 0, "")
	}
	if r.TLS == nil && auth.IsHTTPS(r) && !truthySetting(db.SettingOrEnv(s.DB, "force_https", "WEEBSYNC_FORCE_HTTPS")) {
		// HTTPS only because the proxy says so; a request that bypasses it
		// (a direct port) would get cookies without Secure
		add("force_https", "warn", 0, "")
	}

	// ---- public address
	switch base := s.baseURL(); {
	case base == "":
		add("base_url", "warn", 0, "")
	case strings.HasPrefix(base, "http://") && !isLoopbackURL(base):
		add("base_url", "risk", 0, base)
	default:
		pass("base_url")
	}

	// ---- who gets in
	if !auth.RegistrationDisabled(s.DB) {
		add("registration_open", "info", 0, "")
	}
	var pending int
	// a count that cannot be read answers the request with an error: shown as
	// zero, it read as "checked and fine"
	count := func(n *int, query string) bool {
		if err := s.DB.QueryRow(query).Scan(n); err != nil {
			dbErrDetail(w, "security check", err)
			return false
		}
		return true
	}
	if !count(&pending, `SELECT COUNT(*) FROM users WHERE approved = 0`) {
		return
	}
	if pending > 0 {
		add("pending_approvals", "info", pending, "")
	}
	// admins who sign in with a password alone
	var weakAdmins int
	if !count(&weakAdmins, `SELECT COUNT(*) FROM users u WHERE u.is_admin = 1 AND u.password_hash != ''
		AND NOT EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL)
		AND NOT EXISTS (SELECT 1 FROM webauthn_credentials c WHERE c.user_id = u.id AND (c.passwordless = 0 OR c.uv_required = 1))`) {
		return
	}
	if weakAdmins > 0 && !s.passwordAuthBlocked() {
		add("admin_single_factor", "warn", weakAdmins, "")
	} else {
		pass("admin_single_factor")
	}
	if wide := broadNetworks(db.Setting(s.DB, "trusted_networks")); wide != "" {
		add("trusted_networks_wide", "risk", 0, wide)
	}

	// ---- outgoing connections that carry secrets
	if db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST") != "" {
		sec := db.SettingOrEnv(s.DB, "smtp_security", "SMTP_SECURITY")
		host := db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST")
		switch {
		case sec == "none" && secret.SettingOrEnv(s.DB, "smtp_password", "SMTP_PASSWORD") != "" && !isLoopbackHost(host):
			add("smtp_cleartext", "risk", 0, host)
		case sec == "none" && !isLoopbackHost(host):
			add("smtp_cleartext", "warn", 0, host)
		default:
			pass("smtp_cleartext")
		}
	}
	var ftp int
	if !count(&ftp, `SELECT COUNT(*) FROM servers WHERE protocol = 'ftp'`) {
		return
	}
	if ftp > 0 {
		add("ftp_cleartext", "warn", ftp, "")
	}
	// browser: the user's own login travels to it, over whatever network the
	// browser is on, so only loopback is safe; the others are calls of this
	// server, safe on an internal network
	for _, c := range []struct {
		id, key, env, secretSetting, secretSettingEnv string
		browser                                       bool
	}{
		{"oidc_http", "oidc_issuer", "OIDC_ISSUER", "oidc_client_secret", "OIDC_CLIENT_SECRET", true},
		{"ai_http", "ai_base_url", "AI_BASE_URL", "ai_api_key", "AI_API_KEY", false},
		{"plex_http", "plex_url", "PLEX_URL", "plex_token", "PLEX_TOKEN", false},
		{"jellyfin_http", "jellyfin_url", "JELLYFIN_URL", "jellyfin_token", "JELLYFIN_TOKEN", false},
	} {
		u := db.SettingOrEnv(s.DB, c.key, c.env)
		safe := isInternalURL(u)
		if c.browser {
			safe = isLoopbackURL(u)
		}
		if strings.HasPrefix(u, "http://") && !safe && secret.SettingOrEnv(s.DB, c.secretSetting, c.secretSettingEnv) != "" {
			add(c.id, "warn", 0, hostOf(u))
		}
	}
	if u := db.Setting(s.DB, "ha_webhook_url"); strings.HasPrefix(u, "http://") && !isInternalURL(u) {
		// the webhook id in the path is the whole credential
		add("ha_webhook_http", "warn", 0, hostOf(u))
	}

	order := map[string]int{"risk": 0, "warn": 1, "info": 2, "ok": 3}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && order[out[j].Level] < order[out[j-1].Level]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// isLoopbackHost: localhost or a loopback address, where cleartext stays on
// the machine.
func isLoopbackHost(h string) bool {
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	a, err := netip.ParseAddr(h)
	return err == nil && a.Unmap().IsLoopback()
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func isLoopbackURL(raw string) bool { return isLoopbackHost(hostOf(raw)) }

// cgnat is the shared address space (RFC 6598) Tailscale and carrier NAT use.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// isInternalURL: the URL's host is reachable only inside a private network,
// where cleartext does not cross the internet: loopback, private, link-local
// or CGNAT addresses, single-label names (Docker services, add-on hostnames)
// and the reserved local suffixes.
func isInternalURL(raw string) bool {
	h := strings.TrimSuffix(strings.ToLower(hostOf(raw)), ".")
	if h == "" {
		return false
	}
	if isLoopbackHost(h) {
		return true
	}
	if a, err := netip.ParseAddr(h); err == nil {
		a = a.Unmap()
		return !a.IsUnspecified() && (a.IsPrivate() || a.IsLinkLocalUnicast() || cgnat.Contains(a))
	}
	if !strings.Contains(h, ".") {
		return true
	}
	for _, suf := range []string{".local", ".lan", ".internal", ".home.arpa", ".localdomain"} {
		if strings.HasSuffix(h, suf) {
			return true
		}
	}
	return false
}

// broadNetworks names the trusted networks so wide that the rate-limit
// bypass covers strangers: any IPv4 prefix shorter than /8, IPv6 shorter
// than /32, or "everything".
func broadNetworks(csv string) string {
	var wide []string
	for _, p := range auth.ParseIPList(csv) {
		if (p.Addr().Is4() && p.Bits() < 8) || (p.Addr().Is6() && !p.Addr().Is4In6() && p.Bits() < 32) {
			wide = append(wide, p.String())
		}
	}
	return strings.Join(wide, ", ")
}
