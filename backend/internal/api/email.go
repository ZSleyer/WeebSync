package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// email notification categories. userCategories are choosable by anyone;
// adminCategories only by admins.
var (
	userCategories  = []string{"download_done", "download_failed", "suggestion", "upgrade"}
	adminCategories = []string{"admin_new_user"}
)

func splitPrefs(csv string) []string {
	out := []string{} // non-nil: marshals as [] instead of null
	for p := range strings.SplitSeq(csv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func randToken() string {
	b := make([]byte, 32)
	// crypto/rand.Read never returns an error on a healthy system (it panics at
	// init otherwise); fail fast rather than ever hand out a low-entropy token.
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// baseURL is the public origin of this instance, used for links in emails.
// The explicit base_url setting wins; the configured redirect URLs serve as
// a fallback so half-configured instances still get working links.
func (s *Server) baseURL() string {
	for _, raw := range []string{
		db.SettingOrEnv(s.DB, "base_url", "WEEBSYNC_BASE_URL"),
		db.SettingOrEnv(s.DB, "oidc_redirect_url", "OIDC_REDIRECT_URL"),
		db.Setting(s.DB, "anilist_redirect_url"),
	} {
		if o, ok := origin(raw); ok {
			return o
		}
	}
	return ""
}

// origin reduces raw to scheme://host when it is an absolute http(s) URL
// without credentials; path, query and fragment are dropped.
func origin(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", false
	}
	return u.Scheme + "://" + u.Host, true
}

// Mail palette and type: the dark Fluid Lycoris tokens from
// design-system/src/fluid-lycoris.css. Mails stay dark - most clients ignore a
// light/dark switch, and inline styles cannot read the CSS variables.
const (
	mailBg       = "#000000" // --bg
	mailCard     = "#0b1120" // --card
	mailLine     = "#1f2a40" // --line
	mailFg       = "#eef2f7" // --fg
	mailFg2      = "#bccadb" // --fg-2
	mailFg3      = "#8ea2b9" // --fg-3
	mailAccent   = "#ef6177" // --accent, red
	mailOnAccent = "#1a0509" // --on-accent
	mailAccent2  = "#33c2b5" // --accent-2, teal
	mailDisplay  = `'Chakra Petch',Bahnschrift,'DIN Alternate',-apple-system,'Segoe UI',sans-serif`
	mailSans     = `'IBM Plex Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
	mailMono     = `'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace`
)

// emailButton renders the main action of a mail (escaped href and label): a
// table cell carries the colour so the whole button is filled even where the
// link's padding is dropped (Outlook's Word engine reads mso-padding-alt).
func emailButton(href, label, margin string) string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:` + margin + `;border-collapse:separate"><tr>` +
		`<td bgcolor="` + mailAccent + `" style="background:` + mailAccent + `;border-radius:8px;mso-padding-alt:10px 18px">` +
		`<a href="` + html.EscapeString(href) + `" style="display:inline-block;padding:10px 18px;color:` + mailOnAccent + `;font-family:` + mailSans + `;font-size:15px;font-weight:600;line-height:20px;text-decoration:none">` + html.EscapeString(label) + `</a>` +
		`</td></tr></table>`
}

// emailLink renders an inline link, underlined so it does not rest on colour
// alone (WCAG 1.4.1).
func emailLink(href, label, size string) string {
	return `<a href="` + html.EscapeString(href) + `" style="color:` + mailAccent + `;font-size:` + size + `;text-decoration:underline">` + html.EscapeString(label) + `</a>`
}

// emailLines renders escaped content lines in the mail's monospace style.
// Words wrap at spaces and are hyphenated in the mail's language where the
// client can; only a token too long for the line (a file name, a URL) breaks
// mid-word. break-all split every word anywhere, without a hyphen.
func emailLines(lines []string) string {
	var items strings.Builder
	for _, l := range lines {
		items.WriteString(`<p style="margin:6px 0;color:` + mailFg2 + `;font-family:` + mailMono + `;font-size:13px;line-height:1.5;overflow-wrap:anywhere;-webkit-hyphens:auto;hyphens:auto">`)
		items.WriteString(html.EscapeString(l))
		items.WriteString(`</p>`)
	}
	return items.String()
}

// oneLine makes foreign data safe for the text/plain part: quoted-printable
// passes line breaks through, so a \r\n in a file name, error note or catalog
// title would write forged lines into the mail (content spoofing). The HTML
// part needs no equivalent - html.EscapeString already covers it.
func oneLine(s string) string {
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return r == '\r' || r == '\n'
	}), " ")
}

// emailHTML wraps pre-rendered content in the WeebSync mail layout. Built to
// the usual mail-client rules: inline styles only (clients drop stylesheets),
// layout tables marked role="presentation" so screen readers skip them, a lang
// attribute, one h1, and a hidden preheader - the line an inbox shows next to
// the subject, which would otherwise be the wordmark. The colour-scheme meta
// tells Apple Mail the mail is already dark, so it is left as it is. manage is
// the notification-settings URL for the footer ("" hides the link).
func emailHTML(locale, preheader, title, content, extra, manage string) string {
	lang := locale
	if _, ok := catalog["email.footer"][lang]; !ok {
		lang = "en" // tr's fallback
	}
	footer := html.EscapeString(tr(locale, "email.footer"))
	if manage != "" {
		footer += ` · ` + emailLink(manage, tr(locale, "email.manage"), "12px")
	}
	// zero-width fillers keep the client from padding a short preheader with
	// the body text
	pad := strings.Repeat("&#847;&zwnj;&nbsp;", 60)
	// the wordmark as in the app's Brand: WEEB red, SYNC teal
	return `<!doctype html>
<html lang="` + html.EscapeString(lang) + `">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>` + html.EscapeString(title) + `</title>
<style>:root{color-scheme:dark;supported-color-schemes:dark}</style>
</head>
<body style="margin:0;padding:0;background:` + mailBg + `">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">` + html.EscapeString(oneLine(preheader)) + pad + `</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailBg + `" style="background:` + mailBg + `"><tr><td align="center" style="padding:24px 12px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="` + mailCard + `" style="max-width:560px;background:` + mailCard + `;border:1px solid ` + mailLine + `;border-radius:14px;border-collapse:separate;font-family:` + mailSans + `">
  <tr><td style="padding:16px 24px;border-bottom:1px solid ` + mailLine + `">
    <span style="color:` + mailAccent + `;font-family:` + mailDisplay + `;font-weight:700;font-size:16px;letter-spacing:3px">WEEB<span style="color:` + mailAccent2 + `">SYNC</span></span>
  </td></tr>
  <tr><td style="padding:24px;color:` + mailFg + `;font-size:15px;line-height:1.5">
    <h1 style="margin:0 0 12px;font-family:` + mailDisplay + `;font-size:20px;line-height:1.3;font-weight:600;color:` + mailFg + `">` + html.EscapeString(title) + `</h1>` +
		content + extra + `
  </td></tr>
  <tr><td style="padding:12px 24px;border-top:1px solid ` + mailLine + `;color:` + mailFg3 + `;font-size:12px;line-height:1.5">` + footer + `</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`
}

// sendVerifyEmail delivers the account-verification link. Fire-and-forget:
// failures are logged, and the send stamp is cleared again so the next login
// attempt mails a fresh link instead of waiting out the day. An admin can
// also set the account a password in the users panel, which verifies it.
func (s *Server) sendVerifyEmail(to, token, locale string) {
	if s.Mail == nil {
		return
	}
	origin := s.baseURL()
	if origin == "" {
		slog.Error("verify email skipped", "reason", "public base URL is not configured")
		return
	}
	link := origin + "/api/auth/verify?token=" + token
	welcome, intro, ignore := tr(locale, "email.verifyWelcome"), tr(locale, "email.verifyIntro"), tr(locale, "email.verifyIgnore")
	text := welcome + "\r\n\r\n" + intro + "\r\n" + link + "\r\n\r\n" + ignore
	button := emailButton(link, tr(locale, "email.verifyButton"), "18px 0") +
		`<p style="margin:6px 0;color:` + mailFg3 + `;font-size:12px">` + html.EscapeString(ignore) + `</p>`
	htmlBody := emailHTML(locale, intro, welcome, emailLines([]string{intro}), button, "")
	if err := s.Mail.Send(to, "WeebSync – "+tr(locale, "email.verifySubject"), text, htmlBody); err != nil {
		slog.Error("verify email failed", "to", to, "err", err)
		// clears the resend throttle so the user can ask again; if this fails
		// they wait out the 24 hours
		_, _ = s.DB.Exec(`UPDATE users SET verify_sent_at = '' WHERE email = ? AND email_verified = 0`, to)
	}
}

// sendResetEmail delivers a password reset link. Fire-and-forget like the
// verification mail: the asker gets the same answer either way.
func (s *Server) sendResetEmail(to, token, locale string) {
	// in the fragment: a browser never sends it, so the token stays out of
	// the reverse proxy's access log and the server's own
	link := s.baseURL() + "/#reset=" + token
	intro, ignore := tr(locale, "email.resetIntro"), tr(locale, "email.resetIgnore")
	text := intro + "\r\n" + link + "\r\n\r\n" + ignore
	button := emailButton(link, tr(locale, "email.resetButton"), "18px 0") +
		`<p style="margin:6px 0;color:` + mailFg3 + `;font-size:12px">` + html.EscapeString(ignore) + `</p>`
	htmlBody := emailHTML(locale, intro, tr(locale, "email.resetSubject"), emailLines([]string{intro}), button, "")
	if err := s.Mail.Send(to, "WeebSync – "+tr(locale, "email.resetSubject"), text, htmlBody); err != nil {
		slog.Warn("reset email", "to", to, "err", err)
	}
}

// reissueVerify mails a fresh link when the user's current one has expired.
func (s *Server) reissueVerify(userID int64, email string) {
	// no link can be built without the public address: stamping a send that
	// never happens held the next try back for a day
	if s.Mail == nil || !s.Mail.Configured() || s.baseURL() == "" {
		return
	}
	token := randToken()
	res, err := s.DB.Exec(`UPDATE users SET verify_token = ?, verify_sent_at = datetime('now')
		WHERE id = ? AND email_verified = 0 AND verify_sent_at <= datetime('now', '-24 hours')`, hashToken(token), userID)
	if err != nil {
		return
	}
	if n, _ := res.RowsAffected(); n == 1 {
		var locale string
		_ = s.DB.QueryRow(`SELECT locale FROM users WHERE id = ?`, userID).Scan(&locale) // empty = default language
		go s.sendVerifyEmail(email, token, locale)
	}
}

// hashLegacyVerifyTokens replaces the verification tokens stored in the clear
// before only their hash was kept, once: a link already in someone's inbox
// keeps working, and a copy of the database stops being a stack of them.
// SQLite has no hash function, so this cannot be a plain migration.
func (s *Server) hashLegacyVerifyTokens() {
	if db.Setting(s.DB, "verify_tokens_hashed_v1") == "1" {
		return
	}
	err := db.Tx(s.DB, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id, verify_token FROM users WHERE verify_token != ''`)
		if err != nil {
			return err
		}
		defer rows.Close()
		type row struct {
			id    int64
			token string
		}
		var all []row
		for rows.Next() {
			var r row
			if rows.Scan(&r.id, &r.token) == nil {
				all = append(all, r)
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range all {
			if _, err := tx.Exec(`UPDATE users SET verify_token = ? WHERE id = ?`, hashToken(r.token), r.id); err != nil {
				return err
			}
		}
		// the flag goes in the same transaction: if it were lost after the
		// hashes were written, the next start would hash the hashes and every
		// link in an inbox would stop working
		return db.SetSetting(tx, "verify_tokens_hashed_v1", "1")
	})
	if err != nil {
		slog.Error("hash verify tokens", "err", err)
	}
}

// handleVerifyEmail consumes a verification token and marks the account
// verified, then redirects to the login page. Public (the link is the secret).
//
// @Summary      Verify email address
// @Description  Consumes an email-verification token and redirects to the login page. Public: the token embedded in the link is the secret.
// @Tags         Email
// @Param        token  query     string  true  "Verification token"
// @Success      303    {string}  string  "Redirect to the login page"
// @Failure      500    {object}  ErrorResponse
// @Router       /api/auth/verify [get]
func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Redirect(w, r, "/?verify=invalid", http.StatusSeeOther)
		return
	}
	// the database keeps only the token's hash, like the reset link's
	res, err := s.DB.Exec(`UPDATE users SET email_verified = 1, verify_token = ''
		WHERE verify_token = ? AND verify_token != '' AND verify_sent_at > datetime('now', '-24 hours')`, hashToken(token))
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Redirect(w, r, "/?verify=invalid", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/?verify=ok", http.StatusSeeOther)
}

// pushAllowed reports whether the user opted this category into web push.
func (s *Server) pushAllowed(userID int64, category string) bool {
	var prefs string
	_ = s.DB.QueryRow(`SELECT push_prefs FROM users WHERE id = ?`, userID).Scan(&prefs) // fails closed: nothing allowed
	return slices.Contains(splitPrefs(prefs), category)
}

// notifyQuiet is the digest quiet period for a user: how long to keep batching
// before a summary goes out. instant keeps the snappy default; hourly/daily
// hold notifications back into a single, less noisy summary.
func (s *Server) notifyQuiet(userID int64) time.Duration {
	var freq string
	_ = s.DB.QueryRow(`SELECT notify_freq FROM users WHERE id = ?`, userID).Scan(&freq) // empty = the default
	switch freq {
	case "hourly":
		return time.Hour
	case "daily":
		return 24 * time.Hour
	default:
		return digestQuiet
	}
}

// NotifyEvent sends a one-off notification (a suggestion or an upgrade found by
// the sweep) to a user, honouring their per-channel category opt-ins. Unlike a
// download it is not batched by the download-queue collector - these events are
// rare, so they go out promptly (respecting the category filters). icon is an
// optional cover for the push; the mail builds its own layout.
// New-series finds are batched by notifyNewSeries before they get here.
func (s *Server) NotifyEvent(userID int64, category, title, body, url, icon string) {
	if s.Push != nil && s.pushAllowed(userID, category) {
		n := push.Notification{Title: title, Body: body, Tag: category, URL: url, Icon: s.pushCoverURL(httpsOnly(icon))}
		s.Push.Notify(userID, n)
	}
	locale := s.userLocale(userID)
	extra, manage := "", ""
	if base := s.baseURL(); base != "" {
		manage = base + "/settings/notifications"
	}
	s.EmailNotify(userID, category, title, oneLine(body), emailHTML(locale, body, title, "<p>"+html.EscapeString(body)+"</p>", extra, manage))
}

// EmailNotify emails a single user for a category they opted into, if their
// address is verified. No-op without SMTP.
func (s *Server) EmailNotify(userID int64, category, subject, body, htmlBody string) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	var email, prefs string
	var verified int
	err := s.DB.QueryRow(`SELECT email, email_prefs, email_verified FROM users WHERE id = ?`, userID).
		Scan(&email, &prefs, &verified)
	if err != nil || verified == 0 || email == "" || !slices.Contains(splitPrefs(prefs), category) {
		return
	}
	go func() {
		if err := s.Mail.Send(email, "WeebSync – "+subject, body, htmlBody); err != nil {
			slog.Warn("notify email", "to", email, "err", err)
		}
	}()
}

// digestQuiet: how long nothing new may arrive before the collected downloads
// go out as one summary. The timer restarts with every finished download, and
// the flush additionally waits for the queue to run dry - a sync should report
// once when it is done, not in instalments while it is still working.
// A var so tests do not have to wait a minute.
var digestQuiet = 1 * time.Minute

// digestItem is one finished/failed download waiting for the digest flush.
type digestItem struct {
	serverID   int64
	remotePath string
	localPath  string // where the file landed; the push offers to play it
	id         int64  // the download row; the push offers to retry a failure
	note       string // error message for failed downloads
	// code is the classified reason behind note, when there is one. The note
	// itself is raw Go text in the language of the kernel; a code the catalog
	// knows becomes a sentence in the reader's language instead.
	code string
}

// reason is what a failed item says about itself, in the reader's language
// where that is possible. A classified failure has a sentence in the catalog;
// anything else keeps the raw text, which at least names something.
func (it digestItem) reason(locale string) string {
	if key := "fsError." + it.code; it.code != "" {
		if s := tr(locale, key); s != key {
			return s
		}
	}
	return it.note
}

// NotifyDownload buffers a finished/failed download and flushes one combined
// notification per user+category - as a mail grouped by series (via the
// catalog match of the file's folder) with cover images, and as a single push.
// Both senders share this one collector: a folder sync must not fire one mail
// (or one push) per episode.
func (s *Server) NotifyDownload(userID int64, category string, it digestItem) {
	key := fmt.Sprintf("%d|%s", userID, category)
	s.digestMu.Lock()
	if s.digest == nil {
		s.digest = map[string][]digestItem{}
		s.digestTimer = map[string]*time.Timer{}
	}
	s.digest[key] = append(s.digest[key], it)
	// every new item pushes the flush back, so a running sync keeps the
	// notification held until it goes quiet
	if t := s.digestTimer[key]; t != nil {
		t.Stop()
	}
	s.digestTimer[key] = time.AfterFunc(s.notifyQuiet(userID), func() { s.flushDigest(key, userID, category) })
	s.digestMu.Unlock()
}

// flushDigest sends what the collector holds for one user+category, but only
// once the download queue has run dry; while anything is still queued or
// running it waits another round instead.
func (s *Server) flushDigest(key string, userID int64, category string) {
	s.digestMu.Lock()
	items := s.digest[key]
	switch {
	case len(items) == 0:
		// a timer that fired just before it was stopped
		s.digestMu.Unlock()
		return
	case s.downloadsPending():
		s.digestTimer[key] = time.AfterFunc(s.notifyQuiet(userID), func() { s.flushDigest(key, userID, category) })
		s.digestMu.Unlock()
		return
	}
	delete(s.digest, key)
	delete(s.digestTimer, key)
	s.digestMu.Unlock()

	locale := s.userLocale(userID)
	s.pushDigest(userID, category, locale, items)
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	var subject, intro string
	switch {
	case category == "download_done" && len(items) == 1:
		subject, intro = tr(locale, "email.downloadDoneOne"), tr(locale, "email.downloadDoneIntroOne")
	case category == "download_done":
		subject, intro = tr(locale, "email.downloadDoneMany", len(items)), tr(locale, "email.downloadDoneIntroMany")
	case len(items) == 1:
		subject, intro = tr(locale, "email.downloadFailedOne"), tr(locale, "email.downloadFailedIntroOne")
	default:
		subject, intro = tr(locale, "email.downloadFailedMany", len(items)), tr(locale, "email.downloadFailedIntroMany")
	}
	text, content := s.renderDigest(locale, intro, items)
	extra, manage := "", ""
	if base := s.baseURL(); base != "" {
		manage = base + "/settings/notifications"
		extra = emailButton(base+"/", tr(locale, "email.openDashboard"), "18px 0 4px")
		text += "\r\n\r\n" + base + "/\r\n" + tr(locale, "email.manage") + ": " + manage
	}
	s.EmailNotify(userID, category, subject, text, emailHTML(locale, intro, subject, content, extra, manage))
}

// downloadsPending reports whether the queue still has work. Paused entries do
// not count - someone paused them on purpose, and waiting for them would hold
// the notification back forever.
func (s *Server) downloadsPending() bool {
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE status IN ('queued','running')`).Scan(&n); err != nil {
		return false // cannot tell: rather notify than stay silent
	}
	return n > 0
}

// pushDigest sends one push for a flushed digest. The text is built from the
// catalog match (series, season, episode) rather than from file names; see
// buildDownloadPush.
func (s *Server) pushDigest(userID int64, category, locale string, items []digestItem) {
	if s.Push == nil || len(items) == 0 || !s.pushAllowed(userID, category) {
		return
	}
	n := buildDownloadPush(locale, category == "download_done", s.pushItems(userID, locale, items))
	n.Tag = category // finished and failed collapse separately
	n.Icon = s.pushCoverURL(n.Icon)
	n.Timestamp = time.Now().UnixMilli()
	s.Push.Notify(userID, n)
}

// renderDigest groups items by their remote series folder, resolves the
// folder's catalog match for title and cover, and renders both mail bodies.
func (s *Server) renderDigest(locale, intro string, items []digestItem) (text, content string) {
	type group struct {
		title, cover, plexLink string
		names                  []string
	}
	order := []string{}
	groups := map[string]*group{}
	for _, it := range items {
		dir := path.Dir(it.remotePath)
		gk := fmt.Sprintf("%d|%s", it.serverID, dir)
		g, ok := groups[gk]
		if !ok {
			g = &group{title: oneLine(path.Base(dir))}
			// the folder itself, or its parent (season subfolders), may
			// carry the catalog match with title and cover
			for _, d := range []string{dir, path.Dir(dir)} {
				if m := s.watchMedia(it.serverID, d); m != nil {
					if m.Title.Romaji != "" {
						g.title = oneLine(m.Title.Romaji)
					}
					g.cover = m.CoverImage.Large
					g.plexLink = s.plexWebLink(m.Title.Romaji, m.Title.English)
					break
				}
			}
			groups[gk] = g
			order = append(order, gk)
		}
		name := path.Base(it.remotePath)
		if reason := it.reason(locale); reason != "" {
			name += ": " + reason
		}
		g.names = append(g.names, oneLine(name))
	}

	var t, c strings.Builder
	t.WriteString(intro)
	c.WriteString(emailLines([]string{intro}))
	for _, gk := range order {
		g := groups[gk]
		t.WriteString("\r\n\r\n")
		t.WriteString(g.title)
		t.WriteString(":\r\n  ")
		t.WriteString(strings.Join(g.names, "\r\n  "))
		body := `<p style="margin:0 0 6px;color:` + mailFg + `;font-size:14px;font-weight:600">` + html.EscapeString(g.title) + `</p>` + emailLines(g.names)
		if g.plexLink != "" {
			body += `<p style="margin:4px 0 0">` + emailLink(g.plexLink, tr(locale, "email.openPlex", s.mediaServerName()), "13px") + `</p>`
			t.WriteString("\r\n  " + s.mediaServerName() + ": ")
			t.WriteString(g.plexLink)
		}
		if g.cover != "" {
			c.WriteString(`<table role="presentation" style="margin:14px 0 0;border-collapse:collapse"><tr><td style="vertical-align:top;padding-right:12px"><img src="`)
			c.WriteString(html.EscapeString(g.cover))
			c.WriteString(`" width="64" alt="" style="display:block;border-radius:6px"></td><td style="vertical-align:top">`)
			c.WriteString(body)
			c.WriteString(`</td></tr></table>`)
		} else {
			c.WriteString(`<div style="margin:14px 0 0">`)
			c.WriteString(body)
			c.WriteString(`</div>`)
		}
	}
	return t.String(), c.String()
}

// EmailNotifyAdmins emails every admin who opted into an admin category,
// localized per recipient; subject/body are catalog keys, args go to the body.
func (s *Server) EmailNotifyAdmins(category, subjectKey, bodyKey string, args ...any) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	rows, err := s.DB.Query(`SELECT email, email_prefs, locale FROM users
		WHERE is_admin = 1 AND email_verified = 1 AND email != ''`)
	if err != nil {
		return
	}
	defer rows.Close()
	type recipient struct{ email, locale string }
	var recipients []recipient
	for rows.Next() {
		var email, prefs, locale string
		// category "": every admin, whatever they subscribed to
		if rows.Scan(&email, &prefs, &locale) == nil && (category == "" || slices.Contains(splitPrefs(prefs), category)) {
			recipients = append(recipients, recipient{email, locale})
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("admin notify email: read recipients", "err", err)
		return // a partial list would silently skip admins
	}
	for _, to := range recipients {
		go func(rc recipient) {
			if rc.locale != "de" {
				rc.locale = "en"
			}
			// args come from users/remote servers, so the body can carry CR/LF
			subject, body := tr(rc.locale, subjectKey), oneLine(tr(rc.locale, bodyKey, args...))
			htmlBody := emailHTML(rc.locale, body, subject, emailLines([]string{body}), "", s.baseURL()+"/settings/notifications")
			if err := s.Mail.Send(rc.email, "WeebSync – "+subject, body, htmlBody); err != nil {
				slog.Warn("admin notify email", "to", rc.email, "err", err)
			}
		}(to)
	}
}

// NotifyDownloadFinished pushes + emails a finished/failed download,
// localized to the owner's stored locale. Wired as transfer.OnFinished.
func (s *Server) NotifyDownloadFinished(d *transfer.Download) {
	if d.Status == "done" {
		s.NotifyDownload(d.UserID, "download_done", digestItem{serverID: d.ServerID, remotePath: d.RemotePath, localPath: d.LocalPath, id: d.ID})
	} else {
		s.NotifyDownload(d.UserID, "download_failed", digestItem{serverID: d.ServerID, remotePath: d.RemotePath, localPath: d.LocalPath, id: d.ID, note: d.Error, code: d.ErrorCode})
	}
}

// EmailPrefsResponse reports the caller's enabled email categories, the
// categories available to them, and whether SMTP delivery is configured.
type EmailPrefsResponse struct {
	Enabled       []string `json:"enabled"`
	Available     []string `json:"available"`
	SmtpAvailable bool     `json:"smtpAvailable"`
}

// handleEmailPrefsGet reports the caller's chosen categories plus which ones
// are available to them (admin categories only for admins).
//
// @Summary      Get email notification preferences
// @Description  Reports the caller's chosen categories, which categories are available to them (admin categories only for admins) and whether SMTP delivery is configured.
// @Tags         Email
// @Produce      json
// @Success      200  {object}  EmailPrefsResponse
// @Security     CookieAuth
// @Router       /api/auth/email-prefs [get]
func (s *Server) handleEmailPrefsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var prefs string
	_ = s.DB.QueryRow(`SELECT email_prefs FROM users WHERE id = ?`, u.ID).Scan(&prefs) // empty = nothing enabled
	available := slices.Clone(userCategories)
	if u.IsAdmin {
		available = append(available, adminCategories...)
	}
	writeJSON(w, http.StatusOK, EmailPrefsResponse{
		Enabled:       splitPrefs(prefs),
		Available:     available,
		SmtpAvailable: s.Mail != nil && s.Mail.Configured(),
	})
}

// EmailPrefsUpdateRequest is the body of PUT /api/auth/email-prefs: the
// categories the caller wants enabled.
type EmailPrefsUpdateRequest struct {
	Enabled []string `json:"enabled"`
}

// EmailPrefsUpdateResponse echoes the categories actually stored after
// dropping any the caller isn't allowed to subscribe to.
type EmailPrefsUpdateResponse struct {
	Enabled []string `json:"enabled"`
}

// handleEmailPrefsPut stores the caller's chosen categories, dropping any that
// aren't valid for them (a non-admin can't subscribe to admin categories).
//
// @Summary      Update email notification preferences
// @Description  Stores the caller's chosen categories, dropping any not valid for them (a non-admin cannot subscribe to admin categories).
// @Tags         Email
// @Accept       json
// @Produce      json
// @Param        prefs  body      EmailPrefsUpdateRequest  true  "Categories to enable"
// @Success      200    {object}  EmailPrefsUpdateResponse
// @Failure      400    {object}  ErrorResponse
// @Failure      415    {object}  ErrorResponse
// @Failure      500    {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/auth/email-prefs [put]
func (s *Server) handleEmailPrefsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in EmailPrefsUpdateRequest
	if !readJSON(w, r, &in) {
		return
	}
	allowed := slices.Clone(userCategories)
	if u.IsAdmin {
		allowed = append(allowed, adminCategories...)
	}
	clean := []string{}
	for _, c := range in.Enabled {
		if slices.Contains(allowed, c) && !slices.Contains(clean, c) {
			clean = append(clean, c)
		}
	}
	if _, err := s.DB.Exec(`UPDATE users SET email_prefs = ? WHERE id = ?`, strings.Join(clean, ","), u.ID); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, EmailPrefsUpdateResponse{Enabled: clean})
}

// handleSmtpTest sends a test mail to the calling admin with the stored mail
// settings, so a wrong host, port or sender shows up here and not as a
// verification mail that never arrives.
//
// @Summary      Send a test email
// @Description  Sends a test email to the calling admin's address with the saved SMTP settings (admin only) and reports the server's answer.
// @Tags         Email
// @Produce      json
// @Success      200  {object}  OkResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      502  {object}  ErrorResponse
// @Failure      503  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/smtp/test [post]
func (s *Server) handleSmtpTest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if s.Mail == nil || !s.Mail.Configured() {
		writeErr(w, http.StatusServiceUnavailable, "no mail server is set up")
		return
	}
	locale := s.userLocale(u.ID)
	subject := tr(locale, "email.testSubject")
	body := tr(locale, "email.testBody")
	if err := s.Mail.Send(u.Email, "WeebSync – "+subject, body, emailHTML(locale, body, subject, emailLines([]string{body}), "", "")); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// notifyPendingUser tells every admin that an account waits for approval.
// Not a subscription: nobody else can let it in.
func (s *Server) notifyPendingUser(email string) {
	s.EmailNotifyAdmins("", "email.pendingUserSubject", "email.pendingUserBody", email)
}

// approved reports whether an admin let the account in.
func (s *Server) approved(userID int64) bool {
	var ok bool
	_ = s.DB.QueryRow(`SELECT approved FROM users WHERE id = ?`, userID).Scan(&ok) // fails closed: not approved
	return ok
}

// mailApproved tells the owner that the account may sign in now.
func (s *Server) mailApproved(userID int64) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	var to, locale string
	if s.DB.QueryRow(`SELECT email, locale FROM users WHERE id = ?`, userID).Scan(&to, &locale) != nil {
		return
	}
	go func() {
		subject := tr(locale, "email.approvedSubject")
		body := tr(locale, "email.approvedBody")
		if base := s.baseURL(); base != "" {
			body += " " + base
		}
		if err := s.Mail.Send(to, "WeebSync – "+subject, body, emailHTML(locale, body, subject, emailLines([]string{body}), "", "")); err != nil {
			slog.Warn("approval mail", "err", err)
		}
	}()
}
