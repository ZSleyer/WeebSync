package api

import "net/http"

type animescheduleMeResponse struct {
	Configured bool   `json:"configured"`
	Connected  bool   `json:"connected"`
	Error      string `json:"error,omitempty"`
}

// handleAnimescheduleMe checks the configured token with one lookup, backing
// the settings page's status and its "test connection" button. Always 200:
// a rejected token is a status, not a request failure.
//
//	@Summary		AnimeSchedule connection status
//	@Description	Report whether the configured AnimeSchedule.net token is accepted.
//	@Tags			Watches
//	@Produce		json
//	@Success		200	{object}	animescheduleMeResponse
//	@Security		CookieAuth
//	@Router			/api/animeschedule/me [get]
func (s *Server) handleAnimescheduleMe(w http.ResponseWriter, r *http.Request) {
	if !s.Animeschedule.Enabled() {
		writeJSON(w, http.StatusOK, animescheduleMeResponse{})
		return
	}
	if err := s.Animeschedule.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusOK, animescheduleMeResponse{Configured: true, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, animescheduleMeResponse{Configured: true, Connected: true})
}
