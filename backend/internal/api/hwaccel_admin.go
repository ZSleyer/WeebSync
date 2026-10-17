package api

import "net/http"

// handleAdminHWAccel reports what the player's transcodes run on and why the
// other encoders were not chosen.
//
// @Summary      Hardware transcoding status
// @Description  The encoder the player transcodes with (NVENC, VA-API or software), the configured WEEBSYNC_HWACCEL mode and, per candidate, a machine-readable diagnosis (code + params). Before the first transcode or probe, "probed" is false and there is no choice (admin only).
// @Tags         Admin
// @Produce      json
// @Success      200  {object}  hwReport
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/hwaccel [get]
func (s *Server) handleAdminHWAccel(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, hwProbe.snapshot())
}

// handleAdminHWAccelProbe tests the encoders again without a restart.
//
// @Summary      Re-run the hardware transcoding probe
// @Description  Runs the test encodes again (a few seconds, at most 90) and replaces the cached choice, so new transcodes use the result. A probe already running is joined, never run twice at once (admin only).
// @Tags         Admin
// @Produce      json
// @Success      200  {object}  hwReport
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/hwaccel/probe [post]
func (s *Server) handleAdminHWAccelProbe(w http.ResponseWriter, r *http.Request) {
	hwProbe.reprobe()
	writeJSON(w, http.StatusOK, hwProbe.snapshot())
}
