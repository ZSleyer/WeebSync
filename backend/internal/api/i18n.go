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
	"push.downloadDoneMany": {
		"en": "%d downloads finished",
		"de": "%d Downloads fertig",
	},
	"push.downloadFailedMany": {
		"en": "%d downloads failed",
		"de": "%d Downloads fehlgeschlagen",
	},
	"push.testTitle": {
		"en": "WeebSync test",
		"de": "WeebSync-Test",
	},
	"push.testBody": {
		"en": "Push notifications are working.",
		"de": "Push-Benachrichtigungen funktionieren.",
	},
	"notify.newSeries": {
		"en": "New series found",
		"de": "Neue Serie gefunden",
	},
	// A folder name on disk, not a label: the leading underscore keeps it out
	// of Plex's way, and it is only ever chosen when the folder is created.
	// Switching the interface language later does not rename what is there.
	// why.*: the one-line reason on a suggestion card, built where the
	// suggestion is; the frontend shows it as is
	"why.season":    {"en": "Season %d is on %s; you own season %s of this show.", "de": "Staffel %d liegt auf %s, lokal hast du Staffel %s."},
	"why.movie":     {"en": "The film is on %s; the series is in your library.", "de": "Der Film liegt auf %s, die Serie ist lokal vorhanden."},
	"why.episodes":  {"en": "%d of %d episodes are here; %s also has episode %s.", "de": "Lokal %d von %d Folgen, auf %s gibt es auch Folge %s."},
	"why.sequel":    {"en": "Plex holds the earlier part of this show (%d of %d episodes); this continuation is not in the library.", "de": "Plex hat den früheren Teil dieser Serie (%d von %d Folgen), diese Fortsetzung fehlt."},
	"why.upgrade":   {"en": "%s has %s.", "de": "%s bietet %s."},
	"why.res":       {"en": "%dp instead of %dp", "de": "%dp statt %dp"},
	"why.dub":       {"en": "dub %s", "de": "Dub %s"},
	"why.sub":       {"en": "subtitles %s", "de": "Untertitel %s"},
	"why.soft":      {"en": "selectable subtitles %s", "de": "wählbare Untertitel %s"},
	"why.dup":       {"en": "%d folders hold this %s; the marked one has the best quality.", "de": "%d Ordner enthalten diese %s, der markierte hat die beste Qualität."},
	"why.dupSeason": {"en": "season", "de": "Staffel"},
	"why.dupFilm":   {"en": "film", "de": "Film"},
	"why.dupep":     {"en": "Episode %s is in this folder more than once, as different files (the parts of a split episode count once).", "de": "Folge %s liegt mehrfach in diesem Ordner, als verschiedene Dateien (die Teile einer geteilten Folge zählen einmal)."},
	"folder.unsorted": {
		"en": "_Unsorted",
		"de": "_Unzugeordnet",
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
