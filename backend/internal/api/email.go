package api

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// email notification categories. userCategories are choosable by anyone;
// adminCategories only by admins.
var (
	userCategories  = []string{"download_done", "download_failed"}
	adminCategories = []string{"admin_new_user"}
)

func splitPrefs(csv string) []string {
	var out []string
	for _, p := range strings.Split(csv, ",") {
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

// sendVerifyEmail delivers the account-verification link. Fire-and-forget:
// failures are logged, the account still exists and can be re-verified once
// SMTP works (admin can also verify via the users panel).
func (s *Server) sendVerifyEmail(to, token, origin string) {
	if s.Mail == nil {
		return
	}
	link := origin + "/api/auth/verify?token=" + token
	body := "Willkommen bei WeebSync!\r\n\r\n" +
		"Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:\r\n" +
		link + "\r\n\r\nWenn du dich nicht registriert hast, ignoriere diese Nachricht."
	if err := s.Mail.Send(to, "WeebSync — E-Mail bestätigen", body); err != nil {
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
// address is verified. Called from the download-finished hook. No-op without SMTP.
func (s *Server) EmailNotify(userID int64, category, subject, body string) {
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
		if err := s.Mail.Send(email, "WeebSync — "+subject, body); err != nil {
			slog.Warn("notify email", "to", email, "err", err)
		}
	}()
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
			if err := s.Mail.Send(addr, "WeebSync — "+subject, body); err != nil {
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
