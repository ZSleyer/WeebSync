package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// @Summary  List downloads
// @Description Lists the authenticated user's downloads (most recent first, up to 500).
// @Tags     Downloads
// @Produce  json
// @Success  200 {array} transfer.Download
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads [get]
func (s *Server) handleDownloadsList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, user_id, server_id, remote_path, local_path, size, transferred, status, error, rate_limit, created_at
		FROM downloads WHERE user_id = ? ORDER BY id DESC LIMIT 500`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	list := []transfer.Download{}
	for rows.Next() {
		var d transfer.Download
		if err := rows.Scan(&d.ID, &d.UserID, &d.ServerID, &d.RemotePath, &d.LocalPath, &d.Size,
			&d.Transferred, &d.Status, &d.Error, &d.RateLimit, &d.CreatedAt); err != nil {
			dbErr(w)
			return
		}
		list = append(list, d)
	}
	writeJSON(w, http.StatusOK, list)
}

// DownloadCreateRequest is the body of handleDownloadCreate.
type DownloadCreateRequest struct {
	ServerID   int64  `json:"serverId"`
	RemotePath string `json:"remotePath"`
	LocalPath  string `json:"localPath"` // relative to download root
	Flat       bool   `json:"flat"`      // no subfolder: files straight into localPath
}

// DownloadCreateResponse is returned by handleDownloadCreate.
type DownloadCreateResponse struct {
	Queued int     `json:"queued"`
	IDs    []int64 `json:"ids"`
}

// handleDownloadCreate queues a file, or syncs a directory (all missing files).
// @Summary  Queue download
// @Description Queues a single file, or syncs a directory (all missing files), from a remote server.
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    body body DownloadCreateRequest true "Download request"
// @Success  201 {object} DownloadCreateResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads [post]
func (s *Server) handleDownloadCreate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in DownloadCreateRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.ServerID == 0 || in.RemotePath == "" {
		writeErr(w, http.StatusBadRequest, "serverId and remotePath required")
		return
	}
	if _, err := s.safeLocal(in.LocalPath); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ids, _, _, err := s.Transfers.Enqueue(u.ID, in.ServerID, in.RemotePath, in.LocalPath, nil, nil, false, in.Flat)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, DownloadCreateResponse{Queued: len(ids), IDs: ids})
}

// handleSyncOnce runs a ONE-OFF sync with the full auto-sync rename pipeline
// (template, Season-folder creation, language filter, Plex ordering) but without
// creating a persistent watch - "like auto-sync, just once". Used by the Sync
// button on upgrade/incomplete suggestions, whose SyncPlan already carries the
// right local target and template.
// @Summary  One-off sync with rename
// @Description Downloads a remote folder once, applying the same rename/template/language-filter as an auto-sync watch, without persisting a watch.
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    body body Watch true "Sync spec (remotePath, localPath, template, ...)"
// @Success  201 {object} DownloadCreateResponse
// @Failure  400 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/sync [post]
func (s *Server) handleSyncOnce(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in Watch
	if !readJSON(w, r, &in) {
		return
	}
	if in.ServerID == 0 || in.RemotePath == "" {
		writeErr(w, http.StatusBadRequest, "serverId and remotePath required")
		return
	}
	if _, err := s.safeLocal(in.LocalPath); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, in.ServerID, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	in.UserID = u.ID
	if in.Mode == "" {
		in.Mode = "template"
	}
	// same enqueue as a watch check, minus persistence: rename via watchNameFn,
	// language filter via watchLangFilter, subfolder off when the template owns
	// the structure.
	ids, _, _, err := s.Transfers.Enqueue(u.ID, in.ServerID, in.RemotePath, in.LocalPath,
		s.watchNameFn(in), s.watchLangFilter(in), true, !in.Subfolder)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, DownloadCreateResponse{Queued: len(ids), IDs: ids})
}

// DownloadsCancelRequest is the body of handleDownloadsCancel.
type DownloadsCancelRequest struct {
	IDs []int64 `json:"ids"`
}

// CancelResponse reports how many downloads were canceled.
type CancelResponse struct {
	Canceled int `json:"canceled"`
}

// handleDownloadsCancel cancels a batch of downloads (undo for an
// accidental sync click); done/errored entries are skipped silently.
// @Summary  Cancel downloads
// @Description Cancels a batch of downloads by id; done, errored, or canceled entries are skipped silently.
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    body body DownloadsCancelRequest true "Download ids to cancel"
// @Success  200 {object} CancelResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/cancel [post]
func (s *Server) handleDownloadsCancel(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in DownloadsCancelRequest
	if !readJSON(w, r, &in) {
		return
	}
	canceled := 0
	for _, id := range in.IDs {
		if s.Transfers.Cancel(u.ID, id) == nil {
			canceled++
		}
	}
	writeJSON(w, http.StatusOK, CancelResponse{Canceled: canceled})
}

// DownloadsBulkRequest is the body of handleDownloadsBulk.
type DownloadsBulkRequest struct {
	Action string  `json:"action"`
	IDs    []int64 `json:"ids"` // empty = every matching download
}

// BulkResponse reports how many downloads a bulk action affected.
type BulkResponse struct {
	Affected int64 `json:"affected"`
}

// handleDownloadsBulk applies pause/resume/cancel/delete to the caller's
// matching downloads - all of them, or only the given ids (multi-select).
// @Summary  Bulk download action
// @Description Applies pause, resume, cancel, or delete to the caller's matching downloads (all, or only the given ids).
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    body body DownloadsBulkRequest true "Bulk action and optional ids"
// @Success  200 {object} BulkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/bulk [post]
func (s *Server) handleDownloadsBulk(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in DownloadsBulkRequest
	if !readJSON(w, r, &in) {
		return
	}
	var from []string
	var fn func(userID, id int64) error
	switch in.Action {
	case "pause":
		from, fn = []string{"running", "queued"}, s.Transfers.Pause
	case "resume":
		from, fn = []string{"paused"}, s.Transfers.Resume
		// explicit selection may also retry failed/canceled entries;
		// a global "resume all" must not resurrect the whole history
		if len(in.IDs) > 0 {
			from = []string{"paused", "error", "canceled"}
		}
	case "cancel":
		from, fn = []string{"running", "queued", "paused"}, s.Transfers.Cancel
	case "delete":
		from = []string{"done", "error", "canceled"}
	default:
		writeErr(w, http.StatusBadRequest, "invalid action")
		return
	}
	q := `user_id = ? AND status IN (?` + strings.Repeat(",?", len(from)-1) + `)`
	args := []any{u.ID}
	for _, f := range from {
		args = append(args, f)
	}
	if len(in.IDs) > 0 {
		q += ` AND id IN (?` + strings.Repeat(",?", len(in.IDs)-1) + `)`
		for _, id := range in.IDs {
			args = append(args, id)
		}
	}
	if in.Action == "delete" {
		res, err := s.DB.Exec(`DELETE FROM downloads WHERE `+q, args...)
		if err != nil {
			dbErr(w)
			return
		}
		n, _ := res.RowsAffected()
		writeJSON(w, http.StatusOK, BulkResponse{Affected: n})
		return
	}
	rows, err := s.DB.Query(`SELECT id FROM downloads WHERE `+q, args...)
	if err != nil {
		dbErr(w)
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	affected := 0
	for _, id := range ids {
		if fn(u.ID, id) == nil {
			affected++
		}
	}
	writeJSON(w, http.StatusOK, BulkResponse{Affected: int64(affected)})
}

// RateLimitRequest is the body of handleGlobalRateLimit and handleDownloadRateLimit.
type RateLimitRequest struct {
	RateLimit int64 `json:"rateLimit"`
}

// RateLimitResponse echoes the global rate limit set by handleGlobalRateLimit.
type RateLimitResponse struct {
	RateLimit int64 `json:"rateLimit"`
}

// handleGlobalRateLimit sets the global transfer limit (bytes/s, 0 =
// unlimited) without going through the full settings payload - the
// dashboard's quick control. Admin only.
// @Summary  Set global rate limit
// @Description Sets the global transfer rate limit in bytes/s (0 = unlimited). Admin only.
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    body body RateLimitRequest true "Global rate limit in bytes/s"
// @Success  200 {object} RateLimitResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  403 {object} ErrorResponse "admin only"
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/ratelimit [put]
func (s *Server) handleGlobalRateLimit(w http.ResponseWriter, r *http.Request) {
	var in RateLimitRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.RateLimit < 0 {
		writeErr(w, http.StatusBadRequest, "rateLimit must be >= 0")
		return
	}
	if err := db.SetSetting(s.DB, "global_rate_limit", strconv.FormatInt(in.RateLimit, 10)); err != nil {
		dbErr(w)
		return
	}
	s.Transfers.SettingsChanged()
	writeJSON(w, http.StatusOK, RateLimitResponse{RateLimit: in.RateLimit})
}

// downloadAction wraps a single-download state transition (pause/resume/cancel)
// keyed by the {id} path segment.
// @Summary  Pause download
// @Description Pauses a queued or running download owned by the caller.
// @Tags     Downloads
// @Produce  json
// @Param    id path int true "Download ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/{id}/pause [post]
//
// @Summary  Resume download
// @Description Resumes a paused download owned by the caller.
// @Tags     Downloads
// @Produce  json
// @Param    id path int true "Download ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/{id}/resume [post]
//
// @Summary  Cancel download
// @Description Cancels a download owned by the caller.
// @Tags     Downloads
// @Produce  json
// @Param    id path int true "Download ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/{id}/cancel [post]
func (s *Server) downloadAction(fn func(userID, id int64) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := auth.UserFrom(r.Context())
		id := pathID(r)
		if err := fn(u.ID, id); err != nil {
			status := http.StatusInternalServerError
			if err == transfer.ErrNotFound {
				status = http.StatusNotFound
			}
			writeErr(w, status, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
	}
}

// @Summary  Set download rate limit
// @Description Sets the transfer rate limit in bytes/s (0 = unlimited) for a single download owned by the caller.
// @Tags     Downloads
// @Accept   json
// @Produce  json
// @Param    id   path int              true "Download ID"
// @Param    body body RateLimitRequest true "Per-download rate limit in bytes/s"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/{id}/ratelimit [put]
func (s *Server) handleDownloadRateLimit(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var in RateLimitRequest
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.Transfers.SetRateLimit(u.ID, id, in.RateLimit); err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// @Summary  Delete download
// @Description Deletes a finished, errored, or canceled download owned by the caller.
// @Tags     Downloads
// @Produce  json
// @Param    id path int true "Download ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  409 {object} ErrorResponse "not found or still active"
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/downloads/{id} [delete]
func (s *Server) handleDownloadDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	res, err := s.DB.Exec(`DELETE FROM downloads WHERE id = ? AND user_id = ?
		AND status IN ('done','error','canceled')`, id, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusConflict, "not found or still active")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleEvents streams download progress as SSE.
// @Summary  Stream download events
// @Description Streams download progress for the authenticated user as Server-Sent Events.
// @Tags     Downloads
// @Produce  text/event-stream
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/events [get]
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	u := auth.UserFrom(r.Context())
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch, unsubscribe := s.Transfers.Subscribe()
	defer unsubscribe()
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			// events carry userId; only forward the user's own
			if !ownsEvent(msg, u.ID) {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		}
	}
}
