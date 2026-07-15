package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// Secrets are write-only: GET reports only whether they are set, PUT with
// an empty string keeps the stored value, "-" clears it.
type settingsPayload struct {
	MaxConcurrent        int64  `json:"maxConcurrent"`
	GlobalRateLimit      int64  `json:"globalRateLimit"` // bytes/s, 0 = unlimited
	RegistrationDisabled bool   `json:"registrationDisabled"`
	AuthMode             string `json:"authMode"` // password | oidc-only | oidc-auto
	AnilistTokenSet      bool   `json:"anilistTokenSet"`
	AnilistToken         string `json:"anilistToken,omitempty"` // write-only
	OidcIssuer           string `json:"oidcIssuer"`
	OidcClientID         string `json:"oidcClientId"`
	OidcRedirectURL      string `json:"oidcRedirectUrl"`
	OidcClientSecretSet  bool   `json:"oidcClientSecretSet"`
	OidcClientSecret     string `json:"oidcClientSecret,omitempty"` // write-only
	OidcEnabled          bool   `json:"oidcEnabled"`
	OidcError            string `json:"oidcError,omitempty"`
}

func (s *Server) settingsState() settingsPayload {
	conc, _ := strconv.ParseInt(db.Setting(s.DB, "max_concurrent"), 10, 64)
	if conc == 0 {
		conc = 3
	}
	limit, _ := strconv.ParseInt(db.Setting(s.DB, "global_rate_limit"), 10, 64)
	return settingsPayload{
		MaxConcurrent:        conc,
		GlobalRateLimit:      limit,
		RegistrationDisabled: auth.RegistrationDisabled(s.DB),
		AuthMode:             auth.AuthMode(s.DB),
		AnilistTokenSet:      db.SettingOrEnv(s.DB, "anilist_token", "ANILIST_TOKEN") != "",
		OidcIssuer:           db.SettingOrEnv(s.DB, "oidc_issuer", "OIDC_ISSUER"),
		OidcClientID:         db.SettingOrEnv(s.DB, "oidc_client_id", "OIDC_CLIENT_ID"),
		OidcRedirectURL:      db.SettingOrEnv(s.DB, "oidc_redirect_url", "OIDC_REDIRECT_URL"),
		OidcClientSecretSet:  db.SettingOrEnv(s.DB, "oidc_client_secret", "OIDC_CLIENT_SECRET") != "",
		OidcEnabled:          s.OIDC.Enabled(),
	}
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

	db.SetSetting(s.DB, "max_concurrent", strconv.FormatInt(in.MaxConcurrent, 10))
	db.SetSetting(s.DB, "global_rate_limit", strconv.FormatInt(in.GlobalRateLimit, 10))
	db.SetSetting(s.DB, "registration_disabled", strconv.FormatBool(in.RegistrationDisabled))
	db.SetSetting(s.DB, "auth_mode", in.AuthMode)
	db.SetSetting(s.DB, "oidc_issuer", in.OidcIssuer)
	db.SetSetting(s.DB, "oidc_client_id", in.OidcClientID)
	db.SetSetting(s.DB, "oidc_redirect_url", in.OidcRedirectURL)
	// secrets are write-only: "" keeps the stored value, "-" clears it
	if in.AnilistToken == "-" {
		db.SetSetting(s.DB, "anilist_token", "")
	} else if in.AnilistToken != "" {
		db.SetSetting(s.DB, "anilist_token", in.AnilistToken)
	}
	if in.OidcClientSecret == "-" {
		db.SetSetting(s.DB, "oidc_client_secret", "")
	} else if in.OidcClientSecret != "" {
		db.SetSetting(s.DB, "oidc_client_secret", in.OidcClientSecret)
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
