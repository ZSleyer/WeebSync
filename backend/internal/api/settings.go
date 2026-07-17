package api

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// validateTrustedNetworks rejects a CSV that contains anything but valid CIDRs
// or bare IPs, so a typo can't silently disable the rate-limit bypass.
func validateTrustedNetworks(csv string) error {
	for part := range strings.SplitSeq(csv, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "/") {
			if _, _, err := net.ParseCIDR(part); err != nil {
				return fmt.Errorf("invalid network %q", part)
			}
		} else if net.ParseIP(part) == nil {
			return fmt.Errorf("invalid ip %q", part)
		}
	}
	return nil
}

// envSettings maps settings keys to their env override and JSON field name.
// A set env var wins over the DB value; the UI locks the field.
var envSettings = []struct{ key, env, field string }{
	{"base_url", "WEEBSYNC_BASE_URL", "baseUrl"},
	{"anilist_client_id", "ANILIST_CLIENT_ID", "anilistClientId"},
	{"anilist_client_secret", "ANILIST_CLIENT_SECRET", "anilistClientSecret"},
	{"tmdb_api_key", "TMDB_API_KEY", "tmdbApiKey"},
	{"plex_url", "PLEX_URL", "plexUrl"},
	{"plex_token", "PLEX_TOKEN", "plexToken"},
	{"oidc_provider_name", "OIDC_PROVIDER_NAME", "oidcProviderName"},
	{"oidc_issuer", "OIDC_ISSUER", "oidcIssuer"},
	{"oidc_client_id", "OIDC_CLIENT_ID", "oidcClientId"},
	{"oidc_client_secret", "OIDC_CLIENT_SECRET", "oidcClientSecret"},
	{"oidc_redirect_url", "OIDC_REDIRECT_URL", "oidcRedirectUrl"},
	{"oidc_claim", "OIDC_CLAIM", "oidcClaim"},
	{"oidc_admin_values", "OIDC_ADMIN_VALUES", "oidcAdminValues"},
	{"oidc_user_values", "OIDC_USER_VALUES", "oidcUserValues"},
	{"smtp_host", "SMTP_HOST", "smtpHost"},
	{"smtp_port", "SMTP_PORT", "smtpPort"},
	{"smtp_security", "SMTP_SECURITY", "smtpSecurity"},
	{"smtp_username", "SMTP_USERNAME", "smtpUsername"},
	{"smtp_from", "SMTP_FROM", "smtpFrom"},
	{"smtp_password", "SMTP_PASSWORD", "smtpPassword"},
}

// envLockedFields returns the JSON field names whose env override is set.
func envLockedFields() []string {
	out := []string{}
	for _, e := range envSettings {
		if os.Getenv(e.env) != "" {
			out = append(out, e.field)
		}
	}
	return out
}

// envLocked reports whether a settings key is overridden by its env var.
func envLocked(key string) bool {
	for _, e := range envSettings {
		if e.key == key {
			return os.Getenv(e.env) != ""
		}
	}
	return false
}

// setSetting writes a settings key unless it is env-locked — a DB write
// would be shadowed by the env value and silently resurface after unset.
func setSetting(d *sql.DB, key, value string) {
	if !envLocked(key) {
		db.SetSetting(d, key, value)
	}
}

// Secrets are write-only: GET reports only whether they are set, PUT with
// an empty string keeps the stored value, "-" clears it.
type settingsPayload struct {
	BaseURL              string `json:"baseUrl"` // public origin of this instance, used in email links
	MaxConcurrent        int64  `json:"maxConcurrent"`
	GlobalRateLimit      int64  `json:"globalRateLimit"`  // bytes/s, 0 = unlimited
	WatchIntervalMin     int64  `json:"watchIntervalMin"` // global auto-sync check interval
	RegistrationDisabled bool   `json:"registrationDisabled"`
	TrustedNetworks      string `json:"trustedNetworks"` // csv of CIDRs/IPs that bypass the login rate limit
	AuthMode             string `json:"authMode"`        // password | oidc-only | oidc-auto
	AnilistClientID      string `json:"anilistClientId"`
	AnilistSecretSet     bool   `json:"anilistSecretSet"`
	AnilistClientSecret  string `json:"anilistClientSecret,omitempty"` // write-only
	AnilistRedirectURL   string `json:"anilistRedirectUrl"`
	TmdbApiKeySet        bool   `json:"tmdbApiKeySet"`
	TmdbApiKey           string `json:"tmdbApiKey,omitempty"` // write-only
	PlexURL              string `json:"plexUrl"`
	PlexTokenSet         bool   `json:"plexTokenSet"`
	PlexToken            string `json:"plexToken,omitempty"` // write-only
	PlexSections         string `json:"plexSections"`        // csv of section keys, empty = all show/movie sections
	PlexSectionSources   string `json:"plexSectionSources"`  // csv of key:source (anilist|tmdb); missing key = by library title
	OidcProviderName     string `json:"oidcProviderName"`    // login button label ("Sign in with X")
	OidcIssuer           string `json:"oidcIssuer"`
	OidcClientID         string `json:"oidcClientId"`
	OidcRedirectURL      string `json:"oidcRedirectUrl"`
	OidcClientSecretSet  bool   `json:"oidcClientSecretSet"`
	OidcClientSecret     string `json:"oidcClientSecret,omitempty"` // write-only
	OidcClaim            string `json:"oidcClaim"`                  // token claim holding groups/roles
	OidcAdminValues      string `json:"oidcAdminValues"`            // csv, any match = admin
	OidcUserValues       string `json:"oidcUserValues"`             // csv login allowlist, empty = everyone
	OidcEnabled          bool   `json:"oidcEnabled"`
	OidcError            string `json:"oidcError,omitempty"`
	SmtpHost             string `json:"smtpHost"`
	SmtpPort             int64  `json:"smtpPort"`
	SmtpUsername         string `json:"smtpUsername"`
	SmtpFrom             string `json:"smtpFrom"`
	SmtpSecurity         string `json:"smtpSecurity"` // starttls | tls | none
	SmtpPasswordSet      bool   `json:"smtpPasswordSet"`
	SmtpPassword         string `json:"smtpPassword,omitempty"` // write-only
	ApiTokenSet          bool   `json:"apiTokenSet"`            // read-only, managed via /api/settings/token
	// json field names whose value comes from an env var; the UI locks them
	EnvLocked []string `json:"envLocked"`
}

func (s *Server) settingsState() settingsPayload {
	conc, _ := strconv.ParseInt(db.Setting(s.DB, "max_concurrent"), 10, 64)
	if conc == 0 {
		conc = 3
	}
	limit, _ := strconv.ParseInt(db.Setting(s.DB, "global_rate_limit"), 10, 64)
	smtpPort, _ := strconv.ParseInt(db.SettingOrEnv(s.DB, "smtp_port", "SMTP_PORT"), 10, 64)
	return settingsPayload{
		BaseURL:              db.SettingOrEnv(s.DB, "base_url", "WEEBSYNC_BASE_URL"),
		MaxConcurrent:        conc,
		GlobalRateLimit:      limit,
		WatchIntervalMin:     int64(s.watchInterval()),
		RegistrationDisabled: auth.RegistrationDisabled(s.DB),
		TrustedNetworks:      db.Setting(s.DB, "trusted_networks"),
		AuthMode:             auth.AuthMode(s.DB),
		AnilistClientID:      db.SettingOrEnv(s.DB, "anilist_client_id", "ANILIST_CLIENT_ID"),
		AnilistSecretSet:     db.SettingOrEnv(s.DB, "anilist_client_secret", "ANILIST_CLIENT_SECRET") != "",
		AnilistRedirectURL:   db.Setting(s.DB, "anilist_redirect_url"),
		TmdbApiKeySet:        db.SettingOrEnv(s.DB, "tmdb_api_key", "TMDB_API_KEY") != "",
		PlexURL:              db.SettingOrEnv(s.DB, "plex_url", "PLEX_URL"),
		PlexTokenSet:         db.SettingOrEnv(s.DB, "plex_token", "PLEX_TOKEN") != "",
		PlexSections:         db.Setting(s.DB, "plex_sections"),
		PlexSectionSources:   db.Setting(s.DB, "plex_section_sources"),
		OidcProviderName:     db.SettingOrEnv(s.DB, "oidc_provider_name", "OIDC_PROVIDER_NAME"),
		OidcIssuer:           db.SettingOrEnv(s.DB, "oidc_issuer", "OIDC_ISSUER"),
		OidcClientID:         db.SettingOrEnv(s.DB, "oidc_client_id", "OIDC_CLIENT_ID"),
		OidcRedirectURL:      db.SettingOrEnv(s.DB, "oidc_redirect_url", "OIDC_REDIRECT_URL"),
		OidcClientSecretSet:  db.SettingOrEnv(s.DB, "oidc_client_secret", "OIDC_CLIENT_SECRET") != "",
		OidcClaim:            db.SettingOrEnv(s.DB, "oidc_claim", "OIDC_CLAIM"),
		OidcAdminValues:      db.SettingOrEnv(s.DB, "oidc_admin_values", "OIDC_ADMIN_VALUES"),
		OidcUserValues:       db.SettingOrEnv(s.DB, "oidc_user_values", "OIDC_USER_VALUES"),
		OidcEnabled:          s.OIDC.Enabled(),
		SmtpHost:             db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST"),
		SmtpPort:             smtpPort,
		SmtpUsername:         db.SettingOrEnv(s.DB, "smtp_username", "SMTP_USERNAME"),
		SmtpFrom:             db.SettingOrEnv(s.DB, "smtp_from", "SMTP_FROM"),
		SmtpSecurity:         smtpSecurity(s.DB),
		SmtpPasswordSet:      db.Setting(s.DB, "smtp_password") != "" || os.Getenv("SMTP_PASSWORD") != "",
		ApiTokenSet:          db.Setting(s.DB, "api_token_hash") != "",
		EnvLocked:            envLockedFields(),
	}
}

func smtpSecurity(d *sql.DB) string {
	if v := db.SettingOrEnv(d, "smtp_security", "SMTP_SECURITY"); v != "" {
		return v
	}
	return "starttls"
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.settingsState())
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	var in settingsPayload
	if !readJSON(w, r, &in) {
		return
	}
	if in.MaxConcurrent < 1 || in.MaxConcurrent > 20 {
		writeErr(w, http.StatusBadRequest, "maxConcurrent must be 1-20")
		return
	}
	if in.GlobalRateLimit < 0 {
		writeErr(w, http.StatusBadRequest, "globalRateLimit must be >= 0")
		return
	}
	if in.WatchIntervalMin < 5 || in.WatchIntervalMin > 1440 {
		writeErr(w, http.StatusBadRequest, "watchIntervalMin must be 5-1440")
		return
	}
	switch in.AuthMode {
	case "password", "oidc-only", "oidc-auto":
	default:
		writeErr(w, http.StatusBadRequest, "invalid authMode")
		return
	}
	// OIDC-only/auto without working OIDC would lock everyone out
	if in.AuthMode != "password" && in.OidcIssuer == "" {
		writeErr(w, http.StatusBadRequest, "authMode requires an OIDC issuer")
		return
	}

	// instance URL: empty or an absolute http(s) origin
	baseURL := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if baseURL != "" {
		u, err := url.Parse(baseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			writeErr(w, http.StatusBadRequest, "baseUrl must be an absolute http(s) URL")
			return
		}
	}
	setSetting(s.DB, "base_url", baseURL)
	setSetting(s.DB, "max_concurrent", strconv.FormatInt(in.MaxConcurrent, 10))
	setSetting(s.DB, "global_rate_limit", strconv.FormatInt(in.GlobalRateLimit, 10))
	setSetting(s.DB, "watch_interval_min", strconv.FormatInt(in.WatchIntervalMin, 10))
	if err := validateTrustedNetworks(in.TrustedNetworks); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	setSetting(s.DB, "registration_disabled", strconv.FormatBool(in.RegistrationDisabled))
	setSetting(s.DB, "trusted_networks", strings.TrimSpace(in.TrustedNetworks))
	setSetting(s.DB, "auth_mode", in.AuthMode)
	setSetting(s.DB, "oidc_provider_name", in.OidcProviderName)
	setSetting(s.DB, "oidc_issuer", strings.TrimSpace(in.OidcIssuer))
	setSetting(s.DB, "oidc_client_id", strings.TrimSpace(in.OidcClientID))
	setSetting(s.DB, "oidc_redirect_url", strings.TrimSpace(in.OidcRedirectURL))
	setSetting(s.DB, "oidc_claim", in.OidcClaim)
	setSetting(s.DB, "oidc_admin_values", in.OidcAdminValues)
	setSetting(s.DB, "oidc_user_values", in.OidcUserValues)
	setSetting(s.DB, "plex_url", strings.TrimSpace(in.PlexURL))
	setSetting(s.DB, "plex_sections", in.PlexSections)
	setSetting(s.DB, "plex_section_sources", in.PlexSectionSources)
	setSetting(s.DB, "anilist_client_id", strings.TrimSpace(in.AnilistClientID))
	setSetting(s.DB, "anilist_redirect_url", strings.TrimSpace(in.AnilistRedirectURL))
	// secrets are write-only: "" keeps the stored value, "-" clears it.
	// Trimmed: IDs/secrets/keys are pasted and stray whitespace breaks
	// authentication in ways that are invisible in the UI.
	if v := strings.TrimSpace(in.AnilistClientSecret); v == "-" {
		setSetting(s.DB, "anilist_client_secret", "")
	} else if v != "" {
		setSetting(s.DB, "anilist_client_secret", v)
	}
	if v := strings.TrimSpace(in.TmdbApiKey); v == "-" {
		setSetting(s.DB, "tmdb_api_key", "")
	} else if v != "" {
		setSetting(s.DB, "tmdb_api_key", v)
	}
	if v := strings.TrimSpace(in.PlexToken); v == "-" {
		setSetting(s.DB, "plex_token", "")
	} else if v != "" {
		setSetting(s.DB, "plex_token", v)
	}
	if v := strings.TrimSpace(in.OidcClientSecret); v == "-" {
		setSetting(s.DB, "oidc_client_secret", "")
	} else if v != "" {
		setSetting(s.DB, "oidc_client_secret", v)
	}

	// SMTP
	switch in.SmtpSecurity {
	case "", "starttls", "tls", "none":
	default:
		writeErr(w, http.StatusBadRequest, "invalid smtpSecurity")
		return
	}
	// the from address becomes the SMTP envelope sender: a bare name gets
	// SRS-rewritten by relays into garbage and flagged as spam
	if f := strings.TrimSpace(in.SmtpFrom); f != "" {
		if _, err := mail.ParseAddress(f); err != nil {
			writeErr(w, http.StatusBadRequest, "smtpFrom must be a valid email address")
			return
		}
	}
	setSetting(s.DB, "smtp_host", strings.TrimSpace(in.SmtpHost))
	setSetting(s.DB, "smtp_port", strconv.FormatInt(in.SmtpPort, 10))
	setSetting(s.DB, "smtp_username", in.SmtpUsername)
	setSetting(s.DB, "smtp_from", strings.TrimSpace(in.SmtpFrom))
	setSetting(s.DB, "smtp_security", in.SmtpSecurity)
	// password is write-only and stored encrypted: "" keeps, "-" clears
	if in.SmtpPassword == "-" {
		setSetting(s.DB, "smtp_password", "")
	} else if in.SmtpPassword != "" {
		enc, err := secret.Encrypt(in.SmtpPassword)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "encrypt error")
			return
		}
		// settings are TEXT: base64 so the raw AES bytes survive storage
		setSetting(s.DB, "smtp_password", base64.StdEncoding.EncodeToString(enc))
	}

	s.Transfers.SettingsChanged()
	// rebuild the OIDC provider; the client sees the effective config + error
	out := s.settingsState()
	if err := s.OIDC.Reload(r.Context()); err != nil {
		out.OidcError = err.Error()
	}
	out.OidcEnabled = s.OIDC.Enabled()
	writeJSON(w, http.StatusOK, out)
}

// ownsEvent checks the userId field of a progress event without a full struct.
func ownsEvent(msg string, userID int64) bool {
	var probe struct {
		UserID int64 `json:"userId"`
	}
	if err := json.Unmarshal([]byte(msg), &probe); err != nil {
		return false
	}
	return probe.UserID == userID
}
