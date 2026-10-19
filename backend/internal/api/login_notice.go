package api

import (
	"crypto/hmac"
	"encoding/hex"
	"html"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/geoip"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/secret"
)

// How the account was signed in to; the keys name the catalog entry
// "login.method.<method>".
const (
	signInPassword    = "password"
	signInPassword2FA = "password2fa"
	signInPasskey     = "passkey"
	signInKey         = "securityKey"
	signInSSO         = "sso"
	// registration signs the new account in; nothing to warn about
	signInRegistered = ""
)

const (
	// knownCookie lists the browsers the account has signed in from, so a
	// sign-in from one it has not seen can be told to the owner. It is its own
	// cookie, not the rate limiter's device cookie: that one is bound to the
	// password, and a password change must not make every device "new".
	// Every sign-in route, the OIDC callback and /api/auth/me included, lives
	// under /api/auth, so the cookie goes no wider.
	knownCookie  = "weebsync_known"
	knownPath    = "/api/auth"
	knownMaxAge  = 400 * 24 * time.Hour
	knownEntries = 4 // kept, newest last
	knownPurpose = "known-device|"
	// the page that lists the sessions, where a notice sends the owner
	sessionsURL = "/settings/account"
)

// knownEntry is "uid.nonce.mac": the MAC binds the nonce to one account, so
// an entry cannot be moved to another user or forged without the server key.
type knownEntry struct {
	uid   int64
	nonce string
}

func knownMAC(uid int64, nonce string) ([]byte, error) {
	return secret.MAC(knownPurpose + strconv.FormatInt(uid, 10) + "|" + nonce)
}

func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// parseKnown reads the cookie value strictly: anything malformed or unsigned
// is dropped, never an error, since a bad cookie only means "unknown".
func parseKnown(v string) []knownEntry {
	var out []knownEntry
	for _, e := range strings.Split(v, "~") {
		parts := strings.Split(e, ".")
		if len(parts) != 3 || parts[0] == "" || len(parts[0]) > 18 || !isHex(parts[1], 32) || !isHex(parts[2], 64) {
			continue
		}
		digits := true
		for _, c := range parts[0] {
			digits = digits && c >= '0' && c <= '9'
		}
		if !digits {
			continue
		}
		uid, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue
		}
		want, err := knownMAC(uid, parts[1])
		if err != nil {
			continue
		}
		got, err := hex.DecodeString(parts[2])
		if err != nil || !hmac.Equal(got, want) {
			continue
		}
		out = append(out, knownEntry{uid, parts[1]})
		if len(out) == knownEntries {
			break
		}
	}
	return out
}

func (e knownEntry) String() string {
	mac, err := knownMAC(e.uid, e.nonce)
	if err != nil {
		return ""
	}
	return strconv.FormatInt(e.uid, 10) + "." + e.nonce + "." + hex.EncodeToString(mac)
}

// knownOf is what the request's cookie holds that the server signed.
func knownOf(r *http.Request) []knownEntry {
	c, err := r.Cookie(knownCookie)
	if err != nil {
		return nil
	}
	return parseKnown(c.Value)
}

// markKnown writes the cookie with an entry for uid: the existing one moves
// to the newest place, or a fresh one is added. It reports whether the browser
// already carried an entry for uid.
func markKnown(w http.ResponseWriter, r *http.Request, uid int64) (wasKnown bool) {
	var kept []knownEntry
	var mine *knownEntry
	for _, e := range knownOf(r) {
		if e.uid == uid {
			mine = &knownEntry{e.uid, e.nonce}
			continue
		}
		kept = append(kept, e)
	}
	wasKnown = mine != nil
	if mine == nil {
		mine = &knownEntry{uid: uid, nonce: randToken()[:32]}
	}
	kept = append(kept, *mine)
	if len(kept) > knownEntries {
		kept = kept[len(kept)-knownEntries:]
	}
	parts := make([]string, 0, len(kept))
	for _, e := range kept {
		if v := e.String(); v != "" {
			parts = append(parts, v)
		}
	}
	if len(parts) == 0 {
		// no key to sign with: nothing to remember, so every sign-in is new
		return wasKnown
	}
	auth.SetCookie(w, r, &http.Cookie{Name: knownCookie, Value: strings.Join(parts, "~"), Path: knownPath, MaxAge: int(knownMaxAge / time.Second)})
	return wasKnown
}

// enrollKnown is the quiet counterpart for an already signed-in browser: it
// adds the entry without a notice. Accounts that signed in before this
// feature existed have no cookie, and without this the first sign-in of each
// of their devices after the upgrade would raise a false alarm. The app asks
// /api/auth/me on start, so every device is enrolled by its first visit.
func enrollKnown(w http.ResponseWriter, r *http.Request, uid int64) {
	for _, e := range knownOf(r) {
		if e.uid == uid {
			return
		}
	}
	markKnown(w, r, uid)
}

// signInAlert runs after every successful sign-in. It remembers the browser
// and, when it is one the account has not signed in from and this is not the
// account's first sign-in ever, tells the owner (see sendLoginNotice).
func (s *Server) signInAlert(w http.ResponseWriter, r *http.Request, userID int64, method string) {
	known := markKnown(w, r, userID)
	// the flag flips once, so two sign-ins racing cannot both be "first"
	res, err := s.DB.Exec(`UPDATE users SET signed_in_before = 1 WHERE id = ? AND signed_in_before = 0`, userID)
	if err != nil {
		slog.Warn("sign-in alert: first sign-in flag", "err", err)
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		slog.Warn("sign-in alert: first sign-in flag", "err", err)
		return
	}
	if known || n > 0 || method == signInRegistered {
		return
	}
	ip, ua := auth.ClientIP(r), r.UserAgent()
	// The throttle collapses repeats from one address (a cookie-less script,
	// a private window signing in over and over), never a sign-in from
	// another one: keyed by account alone, a stranger signing in right after
	// the owner's new phone would be enrolled without a word.
	if s.loginNoticeLimiter != nil {
		if ok, _ := s.loginNoticeLimiter.take("login-notice:" + strconv.FormatInt(userID, 10) + "|" + ip); !ok {
			return
		}
	}
	if len(ua) > 200 {
		// a cut through a multi-byte character would leave invalid UTF-8
		ua = strings.ToValidUTF8(ua[:200], "")
	}
	when := time.Now().UTC()
	place := placeLabel(geoipPlace(s.geoipReader(), ip))
	s.spawn(func() { s.sendLoginNotice(userID, method, when, ip, ua, place) })
}

// placeLabel is "Darmstadt, DE", or whichever half is known.
func placeLabel(p geoip.Place) string {
	switch {
	case p.City != "" && p.Country != "":
		return p.City + ", " + p.Country
	case p.City != "":
		return p.City
	}
	return p.Country
}

// browserName is "Firefox · Linux" from a user agent, with the rules of the
// session list in the UI: enough to tell browsers apart.
func browserName(ua string) string {
	if ua == "" {
		return ""
	}
	browser, os := "", ""
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/") || strings.Contains(ua, "Chromium/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	switch {
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad"):
		os = "iOS"
	case strings.Contains(ua, "Windows"):
		os = "Windows"
	case strings.Contains(ua, "Mac OS X"):
		os = "macOS"
	case strings.Contains(ua, "Linux"):
		os = "Linux"
	}
	switch {
	case browser != "" && os != "":
		return browser + " · " + os
	case browser != "":
		return browser
	case os != "":
		return os
	case len(ua) > 40:
		return strings.ToValidUTF8(ua[:40], "")
	}
	return ua
}

// sendLoginNotice delivers the warning: by mail when mail is set up and the
// user has an address, else by web push, else only a log line. Never both.
func (s *Server) sendLoginNotice(userID int64, method string, when time.Time, ip, ua, place string) {
	var to, locale string
	if err := s.DB.QueryRow(`SELECT email, locale FROM users WHERE id = ?`, userID).Scan(&to, &locale); err != nil {
		slog.Warn("login notice: user lookup", "err", err)
		return
	}
	browser := browserName(ua)
	if browser == "" {
		browser = tr(locale, "login.unknownBrowser")
	}
	if s.Mail != nil && s.Mail.Configured() && to != "" {
		where := tr(locale, "login.where", when.Format("2006-01-02 15:04 UTC"), browser, ip, tr(locale, "login.method."+method))
		if place != "" {
			where = tr(locale, "login.whereWithPlace", when.Format("2006-01-02 15:04 UTC"), browser, place, ip, tr(locale, "login.method."+method))
		}
		subject := tr(locale, "login.title")
		what := tr(locale, "login.body")
		notMe := tr(locale, "login.notMe")
		text := what + "\r\n\r\n" + where + "\r\n\r\n" + notMe
		extra := `<p style="margin:12px 0;color:#8b949e;font-size:12px">` + html.EscapeString(where) + `</p>` +
			`<p style="margin:12px 0;color:#e6edf3;font-size:13px">` + html.EscapeString(notMe) + `</p>`
		htmlBody := emailHTML(locale, subject, emailLines([]string{what}), extra, "")
		if err := s.sendSecurityMail(to, "WeebSync – "+subject, text, htmlBody); err != nil {
			slog.Warn("login notice", "err", err)
		}
		return
	}
	line := browser
	if place != "" {
		line += " · " + place
	}
	n := push.Notification{
		Title:     tr(locale, "login.title"),
		Body:      line,
		Tag:       "login-notice",
		URL:       sessionsURL,
		Timestamp: when.UnixMilli(),
		Urgency:   "high",
	}
	if s.securityPush != nil {
		s.securityPush(userID, n)
		return
	}
	if s.Push == nil {
		slog.Info("login notice: no mail server and no push service", "user", userID, "ip", logSafe(ip))
		return
	}
	var subs int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, userID).Scan(&subs); err != nil {
		slog.Warn("login notice: push subscriptions", "err", err)
		return
	}
	if subs == 0 {
		slog.Info("login notice: no mail server and no push subscription", "user", userID, "ip", logSafe(ip))
		return
	}
	s.Push.Notify(userID, n)
}
