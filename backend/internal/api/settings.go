package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

type settingsPayload struct {
	MaxConcurrent        int64 `json:"maxConcurrent"`
	GlobalRateLimit      int64 `json:"globalRateLimit"` // bytes/s, 0 = unlimited
	RegistrationDisabled bool  `json:"registrationDisabled"`
}

func (s *Server) readSetting(key, def string) string {
	v := def
	s.DB.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v
}

func (s *Server) writeSetting(key, value string) error {
	_, err := s.DB.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	conc, _ := strconv.ParseInt(s.readSetting("max_concurrent", "3"), 10, 64)
	limit, _ := strconv.ParseInt(s.readSetting("global_rate_limit", "0"), 10, 64)
	writeJSON(w, http.StatusOK, settingsPayload{
		MaxConcurrent:        conc,
		GlobalRateLimit:      limit,
		RegistrationDisabled: s.readSetting("registration_disabled", "false") == "true",
	})
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
	s.writeSetting("max_concurrent", strconv.FormatInt(in.MaxConcurrent, 10))
	s.writeSetting("global_rate_limit", strconv.FormatInt(in.GlobalRateLimit, 10))
	s.writeSetting("registration_disabled", strconv.FormatBool(in.RegistrationDisabled))
	s.Transfers.SettingsChanged()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
