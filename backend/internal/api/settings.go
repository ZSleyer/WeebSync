package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/transfer"
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

// applyProxyConfig pushes the stored deployment posture into the auth package,
// which resolves the client IP and the cookie's Secure flag from it. Called at
// startup and after every settings save, so both configuration paths - env for
// a container, the UI for a bare install - end up in the same place.
// warnEnvSecretURLs logs the env-provided URLs that carry a credential in
// clear text across the internet. Env values are the operator's and never
// refused, but this says so where they look.
func warnEnvSecretURLs() {
	for _, env := range []string{"OIDC_ISSUER", "AI_BASE_URL", "PLEX_URL", "JELLYFIN_URL"} {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			if err := checkSecretURL(v); err != nil {
				slog.Warn("credential URL from the environment is not safe", "env", env, "err", err)
			}
		}
	}
}

func (s *Server) applyProxyConfig() {
	auth.SetProxyConfig(db.Setting(s.DB, "trusted_proxies"), truthySetting(db.Setting(s.DB, "force_https")))
	// the public origin is ours even when a proxy hands the request a
	// different Host: an older browser without Sec-Fetch-Site is judged by
	// Origin against Host, and must not lose every POST behind such a proxy.
	// Rebuilt from scratch on every save: the protection can only add origins,
	// so a changed base URL would otherwise leave the old one trusted until a
	// restart.
	c := http.NewCrossOriginProtection()
	if o := s.baseURL(); o != "" {
		if err := c.AddTrustedOrigin(o); err != nil {
			slog.Warn("trusted origin refused", "origin", o, "err", err)
		}
	}
	s.crossOrigin.Store(c)
}

// CrossOrigin refuses state-changing requests a browser sends on behalf of
// another site, subdomains of our own included (Go's CrossOriginProtection:
// Sec-Fetch-Site, else Origin against Host). SameSite=Lax alone lets a
// sibling subdomain post with the session cookie, and the JSON content-type
// check misses the routes without a body. Requests with neither header are
// not from a browser and pass: the identity provider's back-channel logout,
// the *arr apps, webhooks. GET, HEAD and OPTIONS always pass, so nothing may
// change state on those.
func (s *Server) CrossOrigin(next http.Handler) http.Handler {
	if s.crossOrigin.Load() == nil {
		s.applyProxyConfig()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.crossOrigin.Load().Check(r); err != nil {
			writeErr(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// truthySetting reads a boolean setting. The env form of these is a string, so
// "true" from the UI and WEEBSYNC_FORCE_HTTPS=1 from a container have to mean
// the same thing.
func truthySetting(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// envSettings maps settings keys to their env override and JSON field name.
// A set env var wins over the DB value; the UI locks the field.
var envSettings = []struct{ key, env, field string }{
	{"base_url", "WEEBSYNC_BASE_URL", "baseUrl"},
	{"trusted_proxies", "WEEBSYNC_TRUSTED_PROXY", "trustedProxies"},
	{"force_https", "WEEBSYNC_FORCE_HTTPS", "forceHttps"},
	{"anilist_client_id", "ANILIST_CLIENT_ID", "anilistClientId"},
	{"anilist_client_secret", "ANILIST_CLIENT_SECRET", "anilistClientSecret"},
	{"tmdb_api_key", "TMDB_API_KEY", "tmdbApiKey"},
	{"tvdb_api_key", "TVDB_API_KEY", "tvdbApiKey"},
	{"animeschedule_token", "ANIMESCHEDULE_TOKEN", "animescheduleToken"},
	{"ai_base_url", "AI_BASE_URL", "aiBaseUrl"},
	{"ai_api_key", "AI_API_KEY", "aiApiKey"},
	{"ai_model", "AI_MODEL", "aiModel"},
	{"ai_search_url", "AI_SEARCH_URL", "aiSearchUrl"},
	{"plex_url", "PLEX_URL", "plexUrl"},
	{"plex_token", "PLEX_TOKEN", "plexToken"},
	{"jellyfin_url", "JELLYFIN_URL", "jellyfinUrl"},
	{"jellyfin_token", "JELLYFIN_TOKEN", "jellyfinToken"},
	{"media_server", "MEDIA_SERVER", "mediaServer"},
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

// setSetting writes a settings key unless it is env-locked - a DB write
// would be shadowed by the env value and silently resurface after unset.
func setSetting(d *sql.DB, key, value string) error {
	if envLocked(key) {
		return nil
	}
	return db.SetSetting(d, key, value)
}

func setSecretSetting(d *sql.DB, key, value string) error {
	if envLocked(key) {
		return nil
	}
	return secret.SetSetting(d, key, value)
}

// Secrets are write-only: GET reports only whether they are set, PUT with
// an empty string keeps the stored value, "-" clears it.
type settingsPayload struct {
	// MatchRouting: which providers matching asks, and in which order (see match_routing.go)
	MatchRouting          matchRouting   `json:"matchRouting"`
	BaseURL               string         `json:"baseUrl"` // public origin of this instance, used in email links
	MaxConcurrent         int64          `json:"maxConcurrent"`
	GlobalRateLimit       int64          `json:"globalRateLimit"`  // bytes/s, 0 = unlimited
	WatchIntervalMin      int64          `json:"watchIntervalMin"` // global auto-sync check interval
	RegistrationDisabled  bool           `json:"registrationDisabled"`
	TrustedNetworks       string         `json:"trustedNetworks"` // csv of CIDRs/IPs that bypass the login rate limit
	TrustedProxies        string         `json:"trustedProxies"`  // csv of CIDRs/IPs whose X-Forwarded-* headers are believed
	ForceHTTPS            bool           `json:"forceHttps"`      // always mark cookies Secure - for a proxy that terminates TLS
	AuthMode              string         `json:"authMode"`        // password | oidc-only | oidc-auto
	AnilistClientID       string         `json:"anilistClientId"`
	AnilistSecretSet      bool           `json:"anilistSecretSet"`
	AnilistClientSecret   string         `json:"anilistClientSecret,omitempty"` // write-only
	AnilistRedirectURL    string         `json:"anilistRedirectUrl"`
	TmdbApiKeySet         bool           `json:"tmdbApiKeySet"`
	TmdbApiKey            string         `json:"tmdbApiKey,omitempty"` // write-only
	TvdbApiKeySet         bool           `json:"tvdbApiKeySet"`
	TvdbApiKey            string         `json:"tvdbApiKey,omitempty"` // write-only, resolves aired-order season boundaries
	AnimescheduleTokenSet bool           `json:"animescheduleTokenSet"`
	AnimescheduleToken    string         `json:"animescheduleToken,omitempty"` // write-only, dates English dub episodes ahead
	AiBaseURL             string         `json:"aiBaseUrl"`                    // OpenAI-compatible endpoint (LiteLLM, OpenRouter, Ollama /v1); empty = assistant off
	AiModel               string         `json:"aiModel"`
	AiApiKeySet           bool           `json:"aiApiKeySet"`
	AiApiKey              string         `json:"aiApiKey,omitempty"` // write-only, optional (local servers need none)
	AiSearchURL           string         `json:"aiSearchUrl"`        // SearXNG base for the assistant's web search; empty = off
	HaWebhookURL          string         `json:"haWebhookUrl"`       // Home Assistant webhook the backend POSTs events to; empty = off
	PlexURL               string         `json:"plexUrl"`
	PlexTokenSet          bool           `json:"plexTokenSet"`
	PlexToken             string         `json:"plexToken,omitempty"` // write-only
	PlexSections          string         `json:"plexSections"`        // csv of section keys, empty = all show/movie sections
	PlexSectionSources    string         `json:"plexSectionSources"`  // csv of key:source (anilist|tmdb); missing key = by library title
	PlexSectionAnime      string         `json:"plexSectionAnime"`    // csv of key:0|1 - does this library hold anime; missing key = guessed from title/agent
	PlexRoots             string         `json:"plexRoots"`           // manual override: newline-separated local dirs where the Plex library is mounted; usually unneeded (auto-detected)
	PlexLibRoots          string         `json:"plexLibRoots"`        // read-only: mounts auto-detected from Plex's reported library locations (flat)
	PlexLibraries         []LibraryRoots `json:"plexLibraries"`       // read-only: detected mounts grouped by their Plex library
	GeoipEnabled          bool           `json:"geoipEnabled"`        // show an approximate location per session, from a DB-IP database the server downloads monthly
	PlexSkipOwned         bool           `json:"plexSkipOwned"`       // auto-sync leaves episodes Plex already holds (under any name) on the remote
	ArrKeySet             bool           `json:"arrKeySet"`           // read-only: the Sonarr/Radarr source is on, managed via /api/settings/arr-key
	ArrCompleteDir        string         `json:"arrCompleteDir"`      // local folder grabs from Sonarr/Radarr land in; must be under a download root
	ArrRoots              string         `json:"arrRoots"`            // newline-separated "appPath => localPath" mappings for apps that see the media under another path
	OidcProviderName      string         `json:"oidcProviderName"`    // login button label ("Sign in with X")
	JellyfinURL           string         `json:"jellyfinUrl"`
	JellyfinTokenSet      bool           `json:"jellyfinTokenSet"`
	JellyfinToken         string         `json:"jellyfinToken,omitempty"`
	MediaServer           string         `json:"mediaServer" enums:"plex,jellyfin"`
	OidcIssuer            string         `json:"oidcIssuer"`
	OidcClientID          string         `json:"oidcClientId"`
	OidcRedirectURL       string         `json:"oidcRedirectUrl"`
	OidcClientSecretSet   bool           `json:"oidcClientSecretSet"`
	OidcClientSecret      string         `json:"oidcClientSecret,omitempty"` // write-only
	OidcClaim             string         `json:"oidcClaim"`                  // token claim holding groups/roles
	OidcAdminValues       string         `json:"oidcAdminValues"`            // csv, any match = admin
	OidcUserValues        string         `json:"oidcUserValues"`             // csv login allowlist, empty = everyone
	OidcEnabled           bool           `json:"oidcEnabled"`
	OidcError             string         `json:"oidcError,omitempty"`
	SmtpHost              string         `json:"smtpHost"`
	SmtpPort              int64          `json:"smtpPort"`
	SmtpUsername          string         `json:"smtpUsername"`
	SmtpFrom              string         `json:"smtpFrom"`
	SmtpSecurity          string         `json:"smtpSecurity"` // starttls | tls | none
	SmtpPasswordSet       bool           `json:"smtpPasswordSet"`
	SmtpPassword          string         `json:"smtpPassword,omitempty"` // write-only
	ApiTokenSet           bool           `json:"apiTokenSet"`            // read-only, managed via /api/settings/token
	DownloadRoots         []string       `json:"downloadRoots"`          // read-only: local roots files may be written to
	DownloadsEnvSet       bool           `json:"downloadsEnvSet"`        // read-only: WEEBSYNC_DOWNLOADS is set (else only the data dir default)
	OnboardingDone        bool           `json:"onboardingDone"`         // first-run wizard finished (or an install that predates it)
	// json field names whose value comes from an env var; the UI locks them
	EnvLocked []string `json:"envLocked"`
	// read-only: json field name -> why its stored value now fails the check a
	// save would run (e.g. the host no longer resolves)
	FieldIssues map[string]string `json:"fieldIssues,omitempty"`
}

// checkOutboundURL accepts "" or an absolute http(s) URL whose host passes the
// netguard. The guard resolves the host, so the answer can change over time.
func checkOutboundURL(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("must be an absolute http(s) URL")
	}
	return netguard.Allowed(u.Hostname())
}

// checkSecretURL is checkOutboundURL for a URL that carries a credential (an
// API key, a token, a client secret, a webhook id): plain http:// only to
// a host inside the operator's own network, never across the internet.
func checkSecretURL(raw string) error {
	if err := checkOutboundURL(raw); err != nil || raw == "" {
		return err
	}
	u, _ := url.Parse(raw)
	if u.Scheme == "http" && !netguard.LocalOnly(u.Hostname()) {
		return fmt.Errorf("http:// only for a host in your own network; use https")
	}
	return nil
}

// fieldIssues re-checks the stored outbound URLs so the UI can mark the one
// that broke since it was saved, without that blocking any save.
func fieldIssues(p settingsPayload) map[string]string {
	out := map[string]string{}
	if err := checkOutboundURL(p.AiSearchURL); err != nil {
		out["aiSearchUrl"] = err.Error()
	}
	for field, v := range map[string]string{"aiBaseUrl": p.AiBaseURL, "haWebhookUrl": p.HaWebhookURL, "plexUrl": p.PlexURL, "jellyfinUrl": p.JellyfinURL, "oidcIssuer": p.OidcIssuer} {
		if err := checkSecretURL(v); err != nil {
			out[field] = err.Error()
		}
	}
	return out
}

func (s *Server) settingsState() settingsPayload {
	conc, _ := strconv.ParseInt(db.Setting(s.DB, "max_concurrent"), 10, 64)
	if conc == 0 {
		conc = 3
	}
	limit, _ := strconv.ParseInt(db.Setting(s.DB, "global_rate_limit"), 10, 64)
	smtpPort, _ := strconv.ParseInt(db.SettingOrEnv(s.DB, "smtp_port", "SMTP_PORT"), 10, 64)
	p := settingsPayload{
		MatchRouting:          s.routing(),
		BaseURL:               db.SettingOrEnv(s.DB, "base_url", "WEEBSYNC_BASE_URL"),
		MaxConcurrent:         conc,
		GlobalRateLimit:       limit,
		WatchIntervalMin:      int64(s.watchInterval()),
		RegistrationDisabled:  auth.RegistrationDisabled(s.DB),
		TrustedNetworks:       db.Setting(s.DB, "trusted_networks"),
		TrustedProxies:        db.SettingOrEnv(s.DB, "trusted_proxies", "WEEBSYNC_TRUSTED_PROXY"),
		ForceHTTPS:            truthySetting(db.SettingOrEnv(s.DB, "force_https", "WEEBSYNC_FORCE_HTTPS")),
		AuthMode:              auth.AuthMode(s.DB),
		AnilistClientID:       db.SettingOrEnv(s.DB, "anilist_client_id", "ANILIST_CLIENT_ID"),
		AnilistSecretSet:      secret.SettingOrEnv(s.DB, "anilist_client_secret", "ANILIST_CLIENT_SECRET") != "",
		AnilistRedirectURL:    db.Setting(s.DB, "anilist_redirect_url"),
		TmdbApiKeySet:         secret.SettingOrEnv(s.DB, "tmdb_api_key", "TMDB_API_KEY") != "",
		TvdbApiKeySet:         secret.SettingOrEnv(s.DB, "tvdb_api_key", "TVDB_API_KEY") != "",
		AnimescheduleTokenSet: secret.SettingOrEnv(s.DB, "animeschedule_token", "ANIMESCHEDULE_TOKEN") != "",
		AiBaseURL:             db.SettingOrEnv(s.DB, "ai_base_url", "AI_BASE_URL"),
		AiModel:               db.SettingOrEnv(s.DB, "ai_model", "AI_MODEL"),
		AiApiKeySet:           secret.SettingOrEnv(s.DB, "ai_api_key", "AI_API_KEY") != "",
		AiSearchURL:           db.SettingOrEnv(s.DB, "ai_search_url", "AI_SEARCH_URL"),
		HaWebhookURL:          db.Setting(s.DB, "ha_webhook_url"),
		PlexURL:               db.SettingOrEnv(s.DB, "plex_url", "PLEX_URL"),
		PlexTokenSet:          secret.SettingOrEnv(s.DB, "plex_token", "PLEX_TOKEN") != "",
		PlexSections:          db.Setting(s.DB, "plex_sections"),
		PlexSectionSources:    db.Setting(s.DB, "plex_section_sources"),
		PlexSectionAnime:      db.Setting(s.DB, "plex_section_anime"),
		PlexRoots:             db.Setting(s.DB, "plex_roots"),
		PlexLibRoots:          db.Setting(s.DB, "plex_lib_roots"),
		PlexLibraries:         plexLibraries(db.Setting(s.DB, "plex_lib_map")),
		GeoipEnabled:          truthySetting(db.Setting(s.DB, "geoip_enabled")),
		PlexSkipOwned:         truthySetting(db.Setting(s.DB, "plex_skip_owned")),
		JellyfinURL:           db.SettingOrEnv(s.DB, "jellyfin_url", "JELLYFIN_URL"),
		JellyfinTokenSet:      secret.SettingOrEnv(s.DB, "jellyfin_token", "JELLYFIN_TOKEN") != "",
		MediaServer:           db.SettingOrEnv(s.DB, "media_server", "MEDIA_SERVER"),
		ArrKeySet:             db.Setting(s.DB, "arr_key_hash") != "",
		ArrCompleteDir:        db.Setting(s.DB, "arr_complete_dir"),
		ArrRoots:              db.Setting(s.DB, "arr_roots"),
		OidcProviderName:      db.SettingOrEnv(s.DB, "oidc_provider_name", "OIDC_PROVIDER_NAME"),
		OidcIssuer:            db.SettingOrEnv(s.DB, "oidc_issuer", "OIDC_ISSUER"),
		OidcClientID:          db.SettingOrEnv(s.DB, "oidc_client_id", "OIDC_CLIENT_ID"),
		OidcRedirectURL:       db.SettingOrEnv(s.DB, "oidc_redirect_url", "OIDC_REDIRECT_URL"),
		OidcClientSecretSet:   secret.SettingOrEnv(s.DB, "oidc_client_secret", "OIDC_CLIENT_SECRET") != "",
		OidcClaim:             db.SettingOrEnv(s.DB, "oidc_claim", "OIDC_CLAIM"),
		OidcAdminValues:       db.SettingOrEnv(s.DB, "oidc_admin_values", "OIDC_ADMIN_VALUES"),
		OidcUserValues:        db.SettingOrEnv(s.DB, "oidc_user_values", "OIDC_USER_VALUES"),
		OidcEnabled:           s.OIDC.Enabled(),
		SmtpHost:              db.SettingOrEnv(s.DB, "smtp_host", "SMTP_HOST"),
		SmtpPort:              smtpPort,
		SmtpUsername:          db.SettingOrEnv(s.DB, "smtp_username", "SMTP_USERNAME"),
		SmtpFrom:              db.SettingOrEnv(s.DB, "smtp_from", "SMTP_FROM"),
		SmtpSecurity:          smtpSecurity(s.DB),
		SmtpPasswordSet:       db.Setting(s.DB, "smtp_password") != "" || os.Getenv("SMTP_PASSWORD") != "",
		ApiTokenSet:           db.Setting(s.DB, "api_token_hash") != "",
		DownloadRoots:         s.localRoots(),
		DownloadsEnvSet:       os.Getenv("WEEBSYNC_DOWNLOADS") != "",
		OnboardingDone:        s.onboardingDone(),
		EnvLocked:             envLockedFields(),
	}
	p.FieldIssues = fieldIssues(p)
	return p
}

// onboardingDone reports whether the first-run wizard still has steps to run.
// It matters for the OIDC-only path: there the account is created by the first
// OIDC login, so the wizard has to pick up again afterwards. An instance that
// already has a server predates the wizard and counts as done - upgrading must
// not greet existing admins with a setup screen.
func (s *Server) onboardingDone() bool {
	if db.Setting(s.DB, "onboarding_done") == "true" {
		return true
	}
	var servers int
	_ = s.DB.QueryRow(`SELECT COUNT(*) FROM servers`).Scan(&servers) // unreadable counts as none
	return servers > 0
}

func smtpSecurity(d *sql.DB) string {
	if v := db.SettingOrEnv(d, "smtp_security", "SMTP_SECURITY"); v != "" {
		return v
	}
	return "starttls"
}

// LibraryRoots is a Plex library and the local mounts detected for it.
type LibraryRoots struct {
	Title string   `json:"title"`
	Roots []string `json:"roots"`
}

// plexLibraries groups the plex_lib_map setting ("root\ttitle" per line) by
// library title, preserving first-seen order, so the settings UI can show which
// detected mounts belong to which library.
func plexLibraries(mapSetting string) []LibraryRoots {
	var order []string
	roots := map[string][]string{}
	for _, ln := range strings.Split(mapSetting, "\n") {
		if ln = strings.TrimSpace(ln); ln == "" {
			continue
		}
		root, title, ok := strings.Cut(ln, "\t")
		if !ok {
			continue
		}
		if _, seen := roots[title]; !seen {
			order = append(order, title)
		}
		dup := false
		for _, r := range roots[title] {
			if r == root {
				dup = true
				break
			}
		}
		if !dup {
			roots[title] = append(roots[title], root)
		}
	}
	out := make([]LibraryRoots, 0, len(order))
	for _, t := range order {
		out = append(out, LibraryRoots{Title: t, Roots: roots[t]})
	}
	return out
}

// handleSettingsGet returns the current instance settings.
//
// @Summary      Get settings
// @Description  Returns the instance settings (admin only). Secrets are reported as set/unset flags only, never their values.
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  settingsPayload
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings [get]
func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.settingsState())
}

// handleSettingsPut updates the instance settings.
//
// @Summary      Update settings
// @Description  Updates the instance settings (admin only). Fields left out keep their value, and only values that differ from the stored ones are checked; a refused save writes nothing. Write-only secrets: an empty string keeps the stored value, "-" clears it. Env-locked keys are ignored. Returns the effective settings, including any OIDC reload error.
// @Tags         Settings
// @Accept       json
// @Produce      json
// @Param        request  body      settingsPayload  true  "settings"
// @Success      200  {object}  settingsPayload
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings [put]
func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	// A save carries the fields its page changed. The body lands on top of the
	// current state, so a field it leaves out keeps its value, and only a value
	// that differs from the stored one is checked: a setting on another page
	// that has gone bad since it was saved (its host stopped resolving) must not
	// block this save. Nothing is written until every check has passed, and then
	// all of it in one transaction - a refused save used to keep whatever was
	// written before the failing check.
	cur := s.settingsState()
	in := cur
	in.MatchRouting = cur.MatchRouting.clone() // the lists would be decoded into cur's own
	if !readJSON(w, r, &in) {
		return
	}
	bad := func(field, msg string) {
		writeErr(w, http.StatusBadRequest, field+": "+msg)
	}
	if in.MaxConcurrent != cur.MaxConcurrent && (in.MaxConcurrent < 1 || in.MaxConcurrent > 20) {
		bad("maxConcurrent", "must be 1-20")
		return
	}
	if in.GlobalRateLimit != cur.GlobalRateLimit && in.GlobalRateLimit < 0 {
		bad("globalRateLimit", "must be >= 0")
		return
	}
	if in.WatchIntervalMin != cur.WatchIntervalMin && (in.WatchIntervalMin < 5 || in.WatchIntervalMin > 1440) {
		bad("watchIntervalMin", "must be 5-1440")
		return
	}
	if !reflect.DeepEqual(in.MatchRouting, cur.MatchRouting) {
		if err := validateRouting(in.MatchRouting); err != nil {
			bad("matchRouting", err.Error())
			return
		}
	}
	in.OidcIssuer = strings.TrimSpace(in.OidcIssuer)
	if in.AuthMode != cur.AuthMode || in.OidcIssuer != cur.OidcIssuer {
		switch in.AuthMode {
		case "password", "oidc-only", "oidc-auto":
		default:
			bad("authMode", "invalid")
			return
		}
		// OIDC-only/auto without working OIDC would lock everyone out
		if in.AuthMode != "password" && in.OidcIssuer == "" {
			bad("authMode", "requires an OIDC issuer")
			return
		}
	}
	// the allowlist names values of the claim: without one it gates nobody,
	// yet still turns on provisioning of every identity the provider vouches for
	if (in.OidcUserValues != cur.OidcUserValues || in.OidcClaim != cur.OidcClaim) &&
		strings.TrimSpace(in.OidcClaim) == "" && strings.TrimSpace(strings.ReplaceAll(in.OidcUserValues, ",", "")) != "" {
		bad("oidcClaim", "required when allowed values are set")
		return
	}

	// instance URL: empty or an absolute http(s) origin
	baseURL := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if baseURL != "" && baseURL != cur.BaseURL {
		u, err := url.Parse(baseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
			(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			bad("baseUrl", "must be an absolute http(s) URL")
			return
		}
	}
	// outbound targets: empty or an absolute http(s) URL that resolves to a
	// dialable host (the guard refuses metadata/link-local; LAN is fine)
	aiURL := strings.TrimRight(strings.TrimSpace(in.AiBaseURL), "/")
	searchURL := strings.TrimRight(strings.TrimSpace(in.AiSearchURL), "/")
	// Home Assistant webhook: the webhook id in the path is the secret per HA's
	// own model
	haURL := strings.TrimSpace(in.HaWebhookURL)
	plexURL := strings.TrimRight(strings.TrimSpace(in.PlexURL), "/")
	jellyfinURL := strings.TrimRight(strings.TrimSpace(in.JellyfinURL), "/")
	// which server runs the library features when both are connected; empty
	// only while none is, refreshPlexRoots fills it with the first one
	if in.MediaServer != cur.MediaServer && in.MediaServer != "plex" && in.MediaServer != "jellyfin" {
		writeErr(w, http.StatusBadRequest, "mediaServer must be plex or jellyfin")
		return
	}
	for _, f := range []struct {
		field, value, stored string
		check                func(string) error
	}{
		{"aiBaseUrl", aiURL, strings.TrimRight(cur.AiBaseURL, "/"), checkSecretURL},
		{"aiSearchUrl", searchURL, strings.TrimRight(cur.AiSearchURL, "/"), checkOutboundURL},
		{"haWebhookUrl", haURL, cur.HaWebhookURL, checkSecretURL},
		{"plexUrl", plexURL, strings.TrimRight(cur.PlexURL, "/"), checkSecretURL},
		{"jellyfinUrl", jellyfinURL, strings.TrimRight(cur.JellyfinURL, "/"), checkSecretURL},
		// the issuer signs the ID tokens that carry the admin group: a
		// forged one over plain HTTP would hand out the instance
		{"oidcIssuer", in.OidcIssuer, cur.OidcIssuer, checkSecretURL},
	} {
		if f.value == f.stored {
			continue
		}
		if err := f.check(f.value); err != nil {
			bad(f.field, err.Error())
			return
		}
	}
	trustedNetworks := strings.TrimSpace(in.TrustedNetworks)
	if trustedNetworks != cur.TrustedNetworks {
		if err := validateTrustedNetworks(trustedNetworks); err != nil {
			bad("trustedNetworks", err.Error())
			return
		}
	}
	// The UI may only name concrete proxies. "trust whatever is in front of
	// me" stays an env-only decision: switched on without a proxy actually
	// there, any client could forge its own address.
	trustedProxies := strings.TrimSpace(in.TrustedProxies)
	if trustedProxies != cur.TrustedProxies {
		if err := validateTrustedNetworks(trustedProxies); err != nil {
			bad("trustedProxies", err.Error())
			return
		}
	}
	arrDir := strings.TrimSpace(in.ArrCompleteDir)
	arrRoots := normalizeRoots(in.ArrRoots)
	if arrDir != "" && (arrDir != cur.ArrCompleteDir || arrRoots != cur.ArrRoots) {
		// the mapping's local side widens the roots the folder is checked
		// against, so the roots this save brings count already.
		// ponytail: a mapping this save removes still counts until it is written
		roots := s.localRoots()
		extra, _ := parsePlexRoots(arrRoots)
		if _, err := transfer.ResolveLocal(append(roots, extra...), arrDir); err != nil {
			bad("arrCompleteDir", err.Error())
			return
		}
	}
	if in.SmtpSecurity != cur.SmtpSecurity {
		switch in.SmtpSecurity {
		case "", "starttls", "tls", "none":
		default:
			bad("smtpSecurity", "invalid")
			return
		}
	}
	// a login over an unencrypted connection would send the password in
	// clear text; Go refuses it at send time with a cryptic error, so say it
	// here (a relay on this machine is the one exception)
	if (in.SmtpSecurity != cur.SmtpSecurity || in.SmtpUsername != cur.SmtpUsername || in.SmtpHost != cur.SmtpHost) &&
		in.SmtpSecurity == "none" && strings.TrimSpace(in.SmtpUsername) != "" && !isLoopbackHost(strings.TrimSpace(in.SmtpHost)) {
		bad("smtpSecurity", "a login needs STARTTLS or TLS: without encryption the password would cross the network in clear text")
		return
	}
	if in.SmtpPort != cur.SmtpPort && (in.SmtpPort < 0 || in.SmtpPort > 65535) {
		bad("smtpPort", "must be 0-65535")
		return
	}
	// the from address becomes the SMTP envelope sender: a bare name gets
	// SRS-rewritten by relays into garbage and flagged as spam
	smtpFrom := strings.TrimSpace(in.SmtpFrom)
	if smtpFrom != "" && smtpFrom != cur.SmtpFrom {
		if _, err := mail.ParseAddress(smtpFrom); err != nil {
			bad("smtpFrom", "must be a valid email address")
			return
		}
	}

	var writes settingWrites
	writes.set("base_url", baseURL)
	if !reflect.DeepEqual(in.MatchRouting, cur.MatchRouting) {
		raw, err := json.Marshal(in.MatchRouting)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "encode error")
			return
		}
		writes.set(matchRoutingKey, string(raw))
	}
	writes.set("ai_base_url", aiURL)
	writes.set("ai_search_url", searchURL)
	writes.set("ha_webhook_url", haURL)
	writes.set("ai_model", strings.TrimSpace(in.AiModel))
	writes.set("max_concurrent", strconv.FormatInt(in.MaxConcurrent, 10))
	writes.set("global_rate_limit", strconv.FormatInt(in.GlobalRateLimit, 10))
	writes.set("watch_interval_min", strconv.FormatInt(in.WatchIntervalMin, 10))
	writes.set("registration_disabled", strconv.FormatBool(in.RegistrationDisabled))
	// one-way: the wizard marks itself done, a later save never reopens it
	if in.OnboardingDone {
		writes.set("onboarding_done", "true")
	}
	writes.set("trusted_networks", trustedNetworks)
	writes.set("trusted_proxies", trustedProxies)
	writes.set("force_https", strconv.FormatBool(in.ForceHTTPS))
	writes.set("auth_mode", in.AuthMode)
	writes.set("oidc_provider_name", in.OidcProviderName)
	writes.set("oidc_issuer", in.OidcIssuer)
	writes.set("oidc_client_id", strings.TrimSpace(in.OidcClientID))
	writes.set("oidc_redirect_url", strings.TrimSpace(in.OidcRedirectURL))
	writes.set("oidc_claim", in.OidcClaim)
	writes.set("oidc_admin_values", in.OidcAdminValues)
	writes.set("oidc_user_values", in.OidcUserValues)
	writes.set("plex_url", plexURL)
	writes.set("jellyfin_url", jellyfinURL)
	writes.set("media_server", in.MediaServer)
	writes.set("plex_sections", in.PlexSections)
	writes.set("plex_skip_owned", strconv.FormatBool(in.PlexSkipOwned))
	writes.set("geoip_enabled", strconv.FormatBool(in.GeoipEnabled))
	// both of these decide what indexPlexLibrary writes onto every local row, so
	// a change has to reach the rows rather than wait out the hourly gate: clear
	// the stamp and the next sweep tick re-indexes.
	if in.PlexSectionSources != cur.PlexSectionSources || in.PlexSectionAnime != cur.PlexSectionAnime {
		writes.set("plex_indexed_at", "")
	}
	writes.set("plex_section_sources", in.PlexSectionSources)
	writes.set("plex_section_anime", in.PlexSectionAnime)
	writes.set("plex_roots", normalizeRoots(in.PlexRoots))
	writes.set("arr_roots", arrRoots)
	writes.set("arr_complete_dir", arrDir)
	writes.set("anilist_client_id", strings.TrimSpace(in.AnilistClientID))
	writes.set("anilist_redirect_url", strings.TrimSpace(in.AnilistRedirectURL))
	writes.set("smtp_host", strings.TrimSpace(in.SmtpHost))
	writes.set("smtp_port", strconv.FormatInt(in.SmtpPort, 10))
	writes.set("smtp_username", in.SmtpUsername)
	writes.set("smtp_from", smtpFrom)
	writes.set("smtp_security", in.SmtpSecurity)
	// secrets are write-only: "" keeps the stored value, "-" clears it.
	// Trimmed: IDs/secrets/keys are pasted and stray whitespace breaks
	// authentication in ways that are invisible in the UI. The SMTP password
	// is taken as typed.
	for _, sec := range []struct{ key, value string }{
		{"anilist_client_secret", strings.TrimSpace(in.AnilistClientSecret)},
		{"tmdb_api_key", strings.TrimSpace(in.TmdbApiKey)},
		{"tvdb_api_key", strings.TrimSpace(in.TvdbApiKey)},
		{"animeschedule_token", strings.TrimSpace(in.AnimescheduleToken)},
		{"ai_api_key", strings.TrimSpace(in.AiApiKey)},
		{"plex_token", strings.TrimSpace(in.PlexToken)},
		{"jellyfin_token", strings.TrimSpace(in.JellyfinToken)},
		{"oidc_client_secret", strings.TrimSpace(in.OidcClientSecret)},
		{"smtp_password", in.SmtpPassword},
	} {
		if sec.value == "" {
			continue
		}
		if sec.value == "-" {
			sec.value = ""
		}
		enc, err := secret.EncodeSetting(sec.value)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "encrypt error")
			return
		}
		writes.set(sec.key, enc)
		if sec.key == "plex_token" {
			// a token typed in is no plex.tv sign-in: the prompt to sign in comes back
			writes.set("plex_auth", "")
		}
		if sec.key == "jellyfin_token" {
			writes.set("jellyfin_auth", "") // same for a pasted API key
		}
	}
	if err := writes.commit(s.DB); err != nil {
		slog.Error("settings save failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// take effect without a restart, and re-read through the settings so an
	// env-locked value keeps winning over whatever the form just sent
	s.applyProxyConfig()
	// the Plex roots widen the local-path allowlist (ffprobe + one-off sync into
	// the library); refresh the transfer manager's copy so downloads there pass,
	// and re-detect the auto roots from Plex in case the connection just changed
	s.Transfers.Roots = s.localRoots()
	s.spawn(s.refreshPlexRoots)
	s.Transfers.SettingsChanged()
	if in.GeoipEnabled != cur.GeoipEnabled {
		if in.GeoipEnabled {
			s.geoipCheck() // opens or downloads the database now, not at the next daily tick
		} else {
			s.stopJob(geoipJob)
			s.dropGeoip()
		}
	}
	// rebuild the OIDC provider; the client sees the effective config + error
	out := s.settingsState()
	if err := s.OIDC.Reload(r.Context()); err != nil {
		out.OidcError = err.Error()
	}
	out.OidcEnabled = s.OIDC.Enabled()
	writeJSON(w, http.StatusOK, out)
}

// settingWrites holds a save's writes until every check has passed. Env-locked
// keys are left out: a DB write would be shadowed by the env value and quietly
// resurface once the variable is unset.
type settingWrites []struct{ key, value string }

func (ws *settingWrites) set(key, value string) {
	if !envLocked(key) {
		*ws = append(*ws, struct{ key, value string }{key, value})
	}
}

func (ws settingWrites) commit(d *sql.DB) error {
	return db.Tx(d, func(tx *sql.Tx) error {
		for _, w := range ws {
			if err := db.SetSetting(tx, w.key, w.value); err != nil {
				return err
			}
		}
		return nil
	})
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
