package api

import (
	"net/http"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// notifyFreqs are the allowed delivery cadences for the batched digest.
var notifyFreqs = []string{"instant", "hourly", "daily"}

// NotifyPrefsResponse reports the caller's web-push category opt-ins, the
// categories available, whether push delivery is configured, and the digest
// frequency. Mail categories keep their own endpoint (email-prefs).
type NotifyPrefsResponse struct {
	Push          []string `json:"push"`
	Available     []string `json:"available"`
	PushAvailable bool     `json:"pushAvailable"`
	Freq          string   `json:"freq"`
}

// handleNotifyPrefsGet reports the caller's push categories and digest frequency.
//
//	@Summary		Get push/notify preferences
//	@Tags			Notifications
//	@Produce		json
//	@Success		200	{object}	NotifyPrefsResponse
//	@Security		CookieAuth
//	@Router			/api/auth/notify-prefs [get]
func (s *Server) handleNotifyPrefsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var push, freq string
	s.DB.QueryRow(`SELECT push_prefs, notify_freq FROM users WHERE id = ?`, u.ID).Scan(&push, &freq)
	available := slices.Clone(userCategories)
	if u.IsAdmin {
		available = append(available, adminCategories...)
	}
	if freq == "" {
		freq = "instant"
	}
	writeJSON(w, http.StatusOK, NotifyPrefsResponse{
		Push:          splitPrefs(push),
		Available:     available,
		PushAvailable: s.Push != nil,
		Freq:          freq,
	})
}

// NotifyPrefsUpdateRequest is the body of PUT /api/auth/notify-prefs.
type NotifyPrefsUpdateRequest struct {
	Push []string `json:"push"`
	Freq string   `json:"freq"`
}

// handleNotifyPrefsPut stores the caller's push categories and digest frequency,
// dropping any categories not valid for them and any unknown frequency.
//
//	@Summary		Update push/notify preferences
//	@Tags			Notifications
//	@Accept			json
//	@Produce		json
//	@Param			prefs	body	NotifyPrefsUpdateRequest	true	"Push categories and frequency"
//	@Success		200	{object}	OkResponse
//	@Failure		415	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/notify-prefs [put]
func (s *Server) handleNotifyPrefsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in NotifyPrefsUpdateRequest
	if !readJSON(w, r, &in) {
		return
	}
	allowed := slices.Clone(userCategories)
	if u.IsAdmin {
		allowed = append(allowed, adminCategories...)
	}
	var clean []string
	for _, c := range in.Push {
		if slices.Contains(allowed, c) && !slices.Contains(clean, c) {
			clean = append(clean, c)
		}
	}
	freq := in.Freq
	if !slices.Contains(notifyFreqs, freq) {
		freq = "instant"
	}
	s.DB.Exec(`UPDATE users SET push_prefs = ?, notify_freq = ? WHERE id = ?`, strings.Join(clean, ","), freq, u.ID)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
