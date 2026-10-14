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
	"email.testSubject": {
		"en": "Test email",
		"de": "Test-E-Mail",
	},
	"email.testBody": {
		"en": "Mail from WeebSync reaches you: the email settings work.",
		"de": "Mail von WeebSync kommt bei dir an: die E-Mail-Einstellungen funktionieren.",
	},
	"email.resetSubject": {
		"en": "Set a new password",
		"de": "Neues Passwort setzen",
	},
	"email.resetIntro": {
		"en": "Someone asked to set a new password for your account. The link is good for an hour and once:",
		"de": "Jemand möchte für dein Konto ein neues Passwort setzen. Der Link gilt eine Stunde und einmal:",
	},
	"email.resetButton": {
		"en": "Set a new password",
		"de": "Neues Passwort setzen",
	},
	"email.resetIgnore": {
		"en": "If that was not you, ignore this message: your password stays as it is.",
		"de": "Warst du das nicht, ignoriere diese Nachricht: dein Passwort bleibt, wie es ist.",
	},
	"email.securityWhere": {
		"en": "When: %s · Address: %s · Browser: %s",
		"de": "Wann: %s · Adresse: %s · Browser: %s",
	},
	"email.securityNotMe": {
		"en": "Was this not you? Sign in to WeebSync, set a new password (or use \"Forgot password\" on the sign-in page) and end all other sessions under Settings → Account.",
		"de": "Warst du das nicht? Melde dich bei WeebSync an, setze ein neues Passwort (oder nutze „Passwort vergessen\" auf der Anmeldeseite) und beende alle anderen Sitzungen unter Einstellungen → Konto.",
	},
	"email.security.passwordChanged": {
		"en": "Your password was changed",
		"de": "Dein Passwort wurde geändert",
	},
	"email.security.passwordChanged.body": {
		"en": "The password of your account was changed. Your other sessions have been ended.",
		"de": "Das Passwort deines Kontos wurde geändert. Deine anderen Sitzungen wurden beendet.",
	},
	"email.security.passwordReset": {
		"en": "Your password was reset",
		"de": "Dein Passwort wurde zurückgesetzt",
	},
	"email.security.passwordReset.body": {
		"en": "A new password was set for your account through a reset link. All sessions have been ended.",
		"de": "Über einen Link aus der Passwort-vergessen-Mail wurde ein neues Passwort für dein Konto gesetzt. Alle Sitzungen wurden beendet.",
	},
	"email.security.passwordAdmin": {
		"en": "An administrator set your password",
		"de": "Ein Administrator hat dein Passwort gesetzt",
	},
	"email.security.passwordAdmin.body": {
		"en": "An administrator of this WeebSync set a new password for your account. All your sessions have been ended.",
		"de": "Ein Administrator dieser WeebSync-Instanz hat ein neues Passwort für dein Konto gesetzt. Alle deine Sitzungen wurden beendet.",
	},
	"email.security.totpOn": {
		"en": "Two-factor sign-in turned on",
		"de": "Zwei-Faktor-Anmeldung eingeschaltet",
	},
	"email.security.totpOn.body": {
		"en": "An authenticator app now has to confirm every password sign-in to your account.",
		"de": "Jede Anmeldung mit Passwort muss jetzt zusätzlich mit einem Code aus einer Authenticator-App bestätigt werden.",
	},
	"email.security.totpOff": {
		"en": "Two-factor sign-in turned off",
		"de": "Zwei-Faktor-Anmeldung ausgeschaltet",
	},
	"email.security.totpOff.body": {
		"en": "Your account no longer asks for a code from an authenticator app after the password.",
		"de": "Dein Konto fragt nach dem Passwort nicht mehr nach einem Code aus der Authenticator-App.",
	},
	"email.security.passkeyAdded": {
		"en": "A passkey was added",
		"de": "Ein Passkey wurde hinzugefügt",
	},
	"email.security.passkeyAdded.body": {
		"en": "A new passkey can now sign in to your account without a password.",
		"de": "Ein neuer Passkey kann sich jetzt ohne Passwort bei deinem Konto anmelden.",
	},
	"email.security.keyAdded": {
		"en": "A security key was added",
		"de": "Ein Sicherheitsschlüssel wurde hinzugefügt",
	},
	"email.security.keyAdded.body": {
		"en": "A new security key can now confirm password sign-ins to your account.",
		"de": "Ein neuer Sicherheitsschlüssel kann jetzt Anmeldungen mit Passwort bei deinem Konto bestätigen.",
	},
	"email.security.credentialRemoved": {
		"en": "A passkey or security key was removed",
		"de": "Ein Passkey oder Sicherheitsschlüssel wurde entfernt",
	},
	"email.security.credentialRemoved.body": {
		"en": "A passkey or security key was removed from your account and can no longer sign in.",
		"de": "Ein Passkey oder Sicherheitsschlüssel wurde von deinem Konto entfernt und kann sich nicht mehr anmelden.",
	},
	"email.pendingUserSubject": {
		"en": "An account waits for approval",
		"de": "Ein Konto wartet auf Freigabe",
	},
	"email.pendingUserBody": {
		"en": "%s signed up and waits for an admin to let them in: Settings → Users.",
		"de": "%s hat sich registriert und wartet darauf, dass ein Admin das Konto freischaltet: Einstellungen → Benutzer.",
	},
	"email.approvedSubject": {
		"en": "Your account is approved",
		"de": "Dein Konto ist freigeschaltet",
	},
	"email.approvedBody": {
		"en": "An admin let your account in. You can sign in now:",
		"de": "Ein Admin hat dein Konto freigeschaltet. Du kannst dich jetzt anmelden:",
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
	// One sentence per classified filesystem failure, for the mail and the push
	// that reach a reader who is not looking at the dashboard. What to change is
	// spelled out there; here it only has to stop being raw Go text.
	"fsError.permission_denied": {
		"en": "no write permission on the target directory",
		"de": "keine Schreibrechte auf dem Zielverzeichnis",
	},
	"fsError.disk_full": {
		"en": "no space left on the target drive",
		"de": "kein Speicherplatz mehr auf dem Ziellaufwerk",
	},
	"fsError.read_only": {
		"en": "the target directory is mounted read-only",
		"de": "das Zielverzeichnis ist schreibgeschützt eingehängt",
	},
	"fsError.rename_failed": {
		"en": "downloaded in full, but the target refuses to be replaced (a network share, a merged mount, or a copy that belongs to someone else)",
		"de": "vollständig geladen, aber das Ziel lässt sich nicht ersetzen (Netzfreigabe, zusammengesetzter Mount oder eine Kopie, die jemand anderem gehört)",
	},
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
