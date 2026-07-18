package api

import "fmt"

// Minimal catalog for server-delivered texts (email, web push) - these cannot
// be localized by the frontend, so the backend translates using the user's
// stored locale. API responses rendered by the frontend stay English and are
// localized there via i18next.
var catalog = map[string]map[string]string{
	"email.footer": {
		"en": "WeebSync · automatic notification",
		"de": "WeebSync · automatische Benachrichtigung",
	},
	"email.manage": {
		"en": "Manage notifications",
		"de": "Benachrichtigungen verwalten",
	},
	"email.verifyWelcome": {
		"en": "Welcome to WeebSync!",
		"de": "Willkommen bei WeebSync!",
	},
	"email.verifyIntro": {
		"en": "Please confirm your email address to activate your account:",
		"de": "Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:",
	},
	"email.verifyIgnore": {
		"en": "If you did not sign up, ignore this message.",
		"de": "Wenn du dich nicht registriert hast, ignoriere diese Nachricht.",
	},
	"email.verifyButton": {
		"en": "Confirm email",
		"de": "E-Mail bestätigen",
	},
	"email.verifySubject": {
		"en": "Confirm your email",
		"de": "E-Mail bestätigen",
	},
	"email.downloadDoneOne": {
		"en": "Download finished",
		"de": "Download fertig",
	},
	"email.downloadDoneMany": {
		"en": "%d downloads finished",
		"de": "%d Downloads fertig",
	},
	"email.downloadDoneIntroOne": {
		"en": "The following download has finished:",
		"de": "Der folgende Download ist fertig:",
	},
	"email.downloadDoneIntroMany": {
		"en": "The following downloads have finished:",
		"de": "Die folgenden Downloads sind fertig:",
	},
	"email.downloadFailedOne": {
		"en": "Download failed",
		"de": "Download fehlgeschlagen",
	},
	"email.downloadFailedMany": {
		"en": "%d downloads failed",
		"de": "%d Downloads fehlgeschlagen",
	},
	"email.downloadFailedIntroOne": {
		"en": "The following download has failed:",
		"de": "Der folgende Download ist fehlgeschlagen:",
	},
	"email.downloadFailedIntroMany": {
		"en": "The following downloads have failed:",
		"de": "Die folgenden Downloads sind fehlgeschlagen:",
	},
	"email.openDashboard": {
		"en": "Open dashboard",
		"de": "Dashboard öffnen",
	},
	"email.openPlex": {
		"en": "Open in Plex ↗",
		"de": "In Plex öffnen ↗",
	},
	"email.newUserSubject": {
		"en": "New registration",
		"de": "Neue Registrierung",
	},
	"email.newUserBody": {
		"en": "New account registered: %s",
		"de": "Neues Konto registriert: %s",
	},
	"push.downloadDone": {
		"en": "Download finished",
		"de": "Download fertig",
	},
	"push.downloadFailed": {
		"en": "Download failed",
		"de": "Download fehlgeschlagen",
	},
}

// tr resolves a catalog key for a locale, falling back to English; extra args
// go through fmt.Sprintf.
func tr(locale, key string, args ...any) string {
	m, ok := catalog[key]
	if !ok {
		return key
	}
	s, ok := m[locale]
	if !ok {
		s = m["en"]
	}
	if len(args) > 0 {
		return fmt.Sprintf(s, args...)
	}
	return s
}

// userLocale returns a user's stored locale, defaulting to English.
func (s *Server) userLocale(userID int64) string {
	var l string
	s.DB.QueryRow(`SELECT locale FROM users WHERE id = ?`, userID).Scan(&l)
	if l == "de" {
		return "de"
	}
	return "en"
}
