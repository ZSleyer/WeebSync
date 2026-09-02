package api

import (
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// Background work runs on its own schedule and used to be invisible unless an
// admin opened the jobs page. A pass over a large library is felt on the
// machine - the hourly Plex index kept a core busy - so it has to be visible
// where people are, and stoppable by whoever runs the instance.
//
// Control is per FAMILY, not per key: keys carry ids ("crawl:2", "m:1:/Show"),
// and nobody wants to pause a folder. The family is the part before the first
// colon, which is exactly the granularity the jobs page lists.

// jobFamily reduces a job key to the family the UI pauses.
func jobFamily(key string) string {
	if i := strings.Index(key, ":"); i > 0 {
		return key[:i]
	}
	return key
}

// pausedFamilies reads the paused set. A settings row rather than memory, so a
// pause survives the restart it was very likely reached for.
func (s *Server) pausedFamilies() []string {
	raw := strings.TrimSpace(db.Setting(s.DB, "jobs_paused"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, f := range strings.Split(raw, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

// jobPaused reports whether this key's family is paused.
func (s *Server) jobPaused(key string) bool {
	if s == nil || s.DB == nil {
		return false
	}
	return slices.Contains(s.pausedFamilies(), jobFamily(key))
}

// stopJob cancels a running job's context. Whether that ends it promptly is up
// to the job: a pass that checks ctx between units stops within one unit, one
// that does not stops at its next natural break. Reported honestly rather than
// promised.
func (s *Server) stopJob(key string) bool {
	s.matchMu.Lock()
	cancel, ok := s.matchJobs[key]
	s.matchMu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

// JobsStatus is the small, non-admin view of background work: what is running
// and what is paused, so the dashboard can say so without exposing the whole
// admin snapshot.
type JobsStatus struct {
	Running []string `json:"running"` // job families currently running
	Paused  []string `json:"paused"`  // job families that will not start
}

// handleJobsStatus reports running and paused job families.
//
// @Summary      Background job status
// @Description  Reports which background job families are running and which are paused, for the dashboard's activity hint.
// @Tags         Admin
// @Produce      json
// @Success      200  {object}  JobsStatus
// @Failure      401  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/jobs [get]
func (s *Server) handleJobsStatus(w http.ResponseWriter, r *http.Request) {
	keys, _ := s.jobsSnapshot()
	families := []string{}
	for _, k := range keys {
		if f := jobFamily(k); !slices.Contains(families, f) {
			families = append(families, f)
		}
	}
	sort.Strings(families)
	paused := s.pausedFamilies()
	if paused == nil {
		paused = []string{}
	}
	writeJSON(w, http.StatusOK, JobsStatus{Running: families, Paused: paused})
}

// JobPauseRequest is the body of handleAdminJobPause.
type JobPauseRequest struct {
	Family string `json:"family"`
	Paused bool   `json:"paused"`
}

// handleAdminJobPause pauses or resumes a job family.
//
// @Summary      Pause a job family
// @Description  Stops a family of background jobs from starting, or lets them start again (admin only). A job already running is unaffected - stop it separately.
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Param        body body JobPauseRequest true "Family and desired state"
// @Success      200  {object}  JobsStatus
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/jobs/pause [post]
func (s *Server) handleAdminJobPause(w http.ResponseWriter, r *http.Request) {
	var in JobPauseRequest
	if !readJSON(w, r, &in) {
		return
	}
	in.Family = jobFamily(strings.TrimSpace(in.Family))
	if in.Family == "" {
		writeErr(w, http.StatusBadRequest, "family required")
		return
	}
	paused := s.pausedFamilies()
	has := slices.Contains(paused, in.Family)
	switch {
	case in.Paused && !has:
		paused = append(paused, in.Family)
	case !in.Paused && has:
		paused = slices.DeleteFunc(paused, func(f string) bool { return f == in.Family })
	}
	sort.Strings(paused)
	db.SetSetting(s.DB, "jobs_paused", strings.Join(paused, ","))
	slog.Info("job family paused", "family", in.Family, "paused", in.Paused,
		"by", auth.UserFrom(r.Context()).ID)
	if paused == nil {
		paused = []string{}
	}
	writeJSON(w, http.StatusOK, JobsStatus{Running: []string{}, Paused: paused})
}

// JobStopResponse says whether a job was actually asked to stop.
type JobStopResponse struct {
	Stopped []string `json:"stopped"` // the job keys that were cancelled
}

// handleAdminJobStop cancels every running job of a family.
//
// @Summary      Stop running jobs
// @Description  Cancels the running jobs of a family (admin only). A job that checks for cancellation stops within one unit of work; one that does not stops at its next natural break.
// @Tags         Admin
// @Produce      json
// @Param        name path string true "Job family"
// @Success      200  {object}  JobStopResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/admin/jobs/{name}/stop [post]
func (s *Server) handleAdminJobStop(w http.ResponseWriter, r *http.Request) {
	family := jobFamily(r.PathValue("name"))
	keys, _ := s.jobsSnapshot()
	stopped := []string{}
	for _, k := range keys {
		if jobFamily(k) == family && s.stopJob(k) {
			stopped = append(stopped, k)
		}
	}
	slog.Info("jobs stopped", "family", family, "count", len(stopped),
		"by", auth.UserFrom(r.Context()).ID)
	writeJSON(w, http.StatusOK, JobStopResponse{Stopped: stopped})
}
