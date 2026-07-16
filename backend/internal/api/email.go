package api

import (
	"crypto/rand"
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
)

// email notification categories. userCategories are choosable by anyone;
// adminCategories only by admins.
var (
	userCategories  = []string{"download_done", "download_failed"}
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
	rand.Read(b)
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
		if u, err := url.Parse(strings.TrimSpace(raw)); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			return u.Scheme + "://" + u.Host
		}
	}
	return ""
}

// emailLines renders escaped content lines in the mail's monospace style.
func emailLines(lines []string) string {
	var items strings.Builder
	for _, l := range lines {
		items.WriteString(`<p style="margin:6px 0;color:#9da7b3;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;word-break:break-all">`)
		items.WriteString(html.EscapeString(l))
		items.WriteString(`</p>`)
	}
	return items.String()
}

// emailHTML wraps pre-rendered content in the WeebSync mail layout (inline
// styles only — email clients ignore stylesheets). manage is the
// notification-settings URL for the footer ("" hides the link).
func emailHTML(title, content, extra, manage string) string {
	footer := `WeebSync · automatische Benachrichtigung`
	if manage != "" {
		footer += ` · <a href="` + html.EscapeString(manage) + `" style="color:#a685f0;text-decoration:none">Benachrichtigungen verwalten</a>`
	}
	return `<div style="background:#0d1117;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d">
    <div style="padding:14px 20px;border-bottom:1px solid #30363d">
      <span style="color:#e6edf3;font-weight:700;font-size:15px;letter-spacing:3px">WEEB<span style="color:#a685f0">SYNC</span></span>
    </div>
    <div style="padding:20px">
      <h1 style="margin:0 0 12px;font-size:16px;font-weight:600;color:#e6edf3">` + html.EscapeString(title) + `</h1>` +
		content + extra + `
    </div>
    <div style="padding:10px 20px;border-top:1px solid #30363d;color:#6e7681;font-size:11px">` + footer + `</div>
  </div>
</div>`
}

// sendVerifyEmail delivers the account-verification link. Fire-and-forget:
// failures are logged, the account still exists and can be re-verified once
// SMTP works (admin can also verify via the users panel).
func (s *Server) sendVerifyEmail(to, token, origin string) {
	if s.Mail == nil {
		return
	}
	// prefer the configured instance URL: the request origin can be wrong
	// behind proxies and is only the fallback
	if base := s.baseURL(); base != "" {
		origin = base
	}
	link := origin + "/api/auth/verify?token=" + token
	text := "Willkommen bei WeebSync!\r\n\r\n" +
		"Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:\r\n" +
		link + "\r\n\r\nWenn du dich nicht registriert hast, ignoriere diese Nachricht."
	button := `<p style="margin:18px 0"><a href="` + html.EscapeString(link) + `" style="background:#a685f0;color:#0d1117;padding:10px 18px;text-decoration:none;font-weight:600;font-size:14px">E-Mail bestätigen</a></p>` +
		`<p style="margin:6px 0;color:#6e7681;font-size:12px">Wenn du dich nicht registriert hast, ignoriere diese Nachricht.</p>`
	htmlBody := emailHTML("Willkommen bei WeebSync!",
		emailLines([]string{"Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren."}), button, "")
	if err := s.Mail.Send(to, "WeebSync – E-Mail bestätigen", text, htmlBody); err != nil {
		slog.Warn("verify email", "to", to, "err", err)
	}
}

// handleVerifyEmail consumes a verification token and marks the account
// verified, then redirects to the login page. Public (the link is the secret).
func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Redirect(w, r, "/?verify=invalid", http.StatusSeeOther)
		return
	}
	res, err := s.DB.Exec(`UPDATE users SET email_verified = 1, verify_token = ''
		WHERE verify_token = ? AND verify_token != ''`, token)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Redirect(w, r, "/?verify=invalid", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/?verify=ok", http.StatusSeeOther)
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

// digestDelay: how long finished downloads are collected before one summary
// mail goes out — a folder sync must not fire one mail per episode.
const digestDelay = 2 * time.Minute

// digestItem is one finished/failed download waiting for the digest flush.
type digestItem struct {
	serverID   int64
	remotePath string
	note       string // error message for failed downloads
}

// EmailNotifyDownload buffers a finished/failed download and flushes one
// combined notification per user+category after digestDelay, grouped by
// series (via the catalog match of the file's folder) with cover images.
func (s *Server) EmailNotifyDownload(userID int64, category string, serverID int64, remotePath, note string) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	key := fmt.Sprintf("%d|%s", userID, category)
	s.digestMu.Lock()
	if s.digest == nil {
		s.digest = map[string][]digestItem{}
	}
	first := len(s.digest[key]) == 0
	s.digest[key] = append(s.digest[key], digestItem{serverID, remotePath, note})
	s.digestMu.Unlock()
	if !first {
		return // a flush timer is already running for this key
	}
	time.AfterFunc(digestDelay, func() {
		s.digestMu.Lock()
		items := s.digest[key]
		delete(s.digest, key)
		s.digestMu.Unlock()
		if len(items) == 0 {
			return
		}
		var subject, intro string
		switch {
		case category == "download_done" && len(items) == 1:
			subject, intro = "Download fertig", "Der folgende Download ist fertig:"
		case category == "download_done":
			subject, intro = fmt.Sprintf("%d Downloads fertig", len(items)), "Die folgenden Downloads sind fertig:"
		case len(items) == 1:
			subject, intro = "Download fehlgeschlagen", "Der folgende Download ist fehlgeschlagen:"
		default:
			subject, intro = fmt.Sprintf("%d Downloads fehlgeschlagen", len(items)), "Die folgenden Downloads sind fehlgeschlagen:"
		}
		text, content := s.renderDigest(intro, items)
		extra, manage := "", ""
		if base := s.baseURL(); base != "" {
			manage = base + "/settings/notifications"
			extra = `<p style="margin:18px 0 4px"><a href="` + html.EscapeString(base) + `/" style="background:#a685f0;color:#0d1117;padding:10px 18px;text-decoration:none;font-weight:600;font-size:14px">Dashboard öffnen</a></p>`
			text += "\r\n\r\n" + base + "/\r\nBenachrichtigungen verwalten: " + manage
		}
		s.EmailNotify(userID, category, subject, text, emailHTML(subject, content, extra, manage))
	})
}

// renderDigest groups items by their remote series folder, resolves the
// folder's catalog match for title and cover, and renders both mail bodies.
func (s *Server) renderDigest(intro string, items []digestItem) (text, content string) {
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
			g = &group{title: path.Base(dir)}
			// the folder itself, or its parent (season subfolders), may
			// carry the catalog match with title and cover
			for _, d := range []string{dir, path.Dir(dir)} {
				if m := s.watchMedia(it.serverID, d); m != nil {
					if m.Title.Romaji != "" {
						g.title = m.Title.Romaji
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
		if it.note != "" {
			name += ": " + it.note
		}
		g.names = append(g.names, name)
	}

	var t, c strings.Builder
	t.WriteString(intro)
	c.WriteString(emailLines([]string{intro}))
	for _, gk := range order {
		g := groups[gk]
		t.WriteString("\r\n\r\n" + g.title + ":\r\n  " + strings.Join(g.names, "\r\n  "))
		body := `<p style="margin:0 0 6px;color:#e6edf3;font-size:14px;font-weight:600">` + html.EscapeString(g.title) + `</p>` + emailLines(g.names)
		if g.plexLink != "" {
			body += `<p style="margin:4px 0 0"><a href="` + html.EscapeString(g.plexLink) + `" style="color:#a685f0;font-size:12px;text-decoration:none">In Plex öffnen ↗</a></p>`
			t.WriteString("\r\n  In Plex: " + g.plexLink)
		}
		if g.cover != "" {
			c.WriteString(`<table role="presentation" style="margin:14px 0 0;border-collapse:collapse"><tr>` +
				`<td style="vertical-align:top;padding-right:12px"><img src="` + html.EscapeString(g.cover) + `" width="64" alt="" style="display:block;border:1px solid #30363d"></td>` +
				`<td style="vertical-align:top">` + body + `</td></tr></table>`)
		} else {
			c.WriteString(`<div style="margin:14px 0 0">` + body + `</div>`)
		}
	}
	return t.String(), c.String()
}

// EmailNotifyAdmins emails every admin who opted into an admin category.
func (s *Server) EmailNotifyAdmins(category, subject, body string) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	rows, err := s.DB.Query(`SELECT email, email_prefs FROM users
		WHERE is_admin = 1 AND email_verified = 1 AND email != ''`)
	if err != nil {
		return
	}
	var recipients []string
	for rows.Next() {
		var email, prefs string
		if rows.Scan(&email, &prefs) == nil && slices.Contains(splitPrefs(prefs), category) {
			recipients = append(recipients, email)
		}
	}
	rows.Close()
	for _, to := range recipients {
		go func(addr string) {
			if err := s.Mail.Send(addr, "WeebSync – "+subject, body, emailHTML(subject, emailLines([]string{body}), "", s.baseURL()+"/settings/notifications")); err != nil {
				slog.Warn("admin notify email", "to", addr, "err", err)
			}
		}(to)
	}
}

// handleEmailPrefsGet reports the caller's chosen categories plus which ones
// are available to them (admin categories only for admins).
func (s *Server) handleEmailPrefsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var prefs string
	s.DB.QueryRow(`SELECT email_prefs FROM users WHERE id = ?`, u.ID).Scan(&prefs)
	available := slices.Clone(userCategories)
	if u.IsAdmin {
		available = append(available, adminCategories...)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":       splitPrefs(prefs),
		"available":     available,
		"smtpAvailable": s.Mail != nil && s.Mail.Configured(),
	})
}

// handleEmailPrefsPut stores the caller's chosen categories, dropping any that
// aren't valid for them (a non-admin can't subscribe to admin categories).
func (s *Server) handleEmailPrefsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Enabled []string `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	allowed := slices.Clone(userCategories)
	if u.IsAdmin {
		allowed = append(allowed, adminCategories...)
	}
	var clean []string
	for _, c := range in.Enabled {
		if slices.Contains(allowed, c) && !slices.Contains(clean, c) {
			clean = append(clean, c)
		}
	}
	if _, err := s.DB.Exec(`UPDATE users SET email_prefs = ? WHERE id = ?`, strings.Join(clean, ","), u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"enabled": clean})
}
