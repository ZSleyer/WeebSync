package api

import (
	"html"
	"log/slog"
	"net/http"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// The changes to an account's way in that its owner hears about by mail, so a
// stranger who got hold of the account cannot quietly make it theirs (NIST
// 800-63B-4 4.6, ASVS 6.3.7). The keys name the catalog entry
// "email.security.<event>".
const (
	noticePasswordChanged = "passwordChanged"
	noticePasswordReset   = "passwordReset"
	noticePasswordAdmin   = "passwordAdmin"
	noticeTotpOn          = "totpOn"
	noticeTotpOff         = "totpOff"
	noticePasskeyAdded    = "passkeyAdded"
	noticeKeyAdded        = "keyAdded"
	noticeCredRemoved     = "credentialRemoved"
)

// sendSecurityMail is the send; tests set Server.securityMail instead.
func (s *Server) sendSecurityMail(to, subject, text, htmlBody string) error {
	if s.securityMail != nil {
		return s.securityMail(to, subject, text, htmlBody)
	}
	return s.Mail.Send(to, subject, text, htmlBody)
}

// securityNotice mails the account's owner that event happened, with when and
// from where. It carries no link: a mail that asks to click something is what
// a phishing mail looks like, so it says where to go instead. Fire-and-forget;
// without a mail server it does nothing.
func (s *Server) securityNotice(r *http.Request, userID int64, event string) {
	if s.Mail == nil || !s.Mail.Configured() {
		return
	}
	var to, locale string
	if err := s.DB.QueryRow(`SELECT email, locale FROM users WHERE id = ?`, userID).Scan(&to, &locale); err != nil {
		return
	}
	ip, ua := auth.ClientIP(r), r.UserAgent()
	if len(ua) > 200 {
		ua = ua[:200]
	}
	when := time.Now().UTC().Format("2006-01-02 15:04 UTC")
	go func() {
		subject := tr(locale, "email.security."+event)
		what := tr(locale, "email.security."+event+".body")
		where := tr(locale, "email.securityWhere", when, ip, ua)
		notMe := tr(locale, "email.securityNotMe")
		text := what + "\r\n\r\n" + where + "\r\n\r\n" + notMe
		extra := `<p style="margin:12px 0;color:` + mailFg3 + `;font-size:12px">` + html.EscapeString(where) + `</p>` +
			`<p style="margin:12px 0;color:` + mailFg + `;font-size:13px">` + html.EscapeString(notMe) + `</p>`
		htmlBody := emailHTML(locale, what, subject, emailLines([]string{what}), extra, "")
		if err := s.sendSecurityMail(to, "WeebSync – "+subject, text, htmlBody); err != nil {
			slog.Warn("security notice", "event", event, "err", err)
		}
	}()
}
