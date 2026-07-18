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

// handleDownloadCreate queues a file, or syncs a directory (all missing files).
func (s *Server) handleDownloadCreate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		ServerID   int64  `json:"serverId"`
		RemotePath string `json:"remotePath"`
		LocalPath  string `json:"localPath"` // relative to download root
		Flat       bool   `json:"flat"`      // no subfolder: files straight into localPath
	}
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
	writeJSON(w, http.StatusCreated, map[string]any{"queued": len(ids), "ids": ids})
}

// handleDownloadsCancel cancels a batch of downloads (undo for an
// accidental sync click); done/errored entries are skipped silently.
func (s *Server) handleDownloadsCancel(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	canceled := 0
	for _, id := range in.IDs {
		if s.Transfers.Cancel(u.ID, id) == nil {
			canceled++
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{"canceled": canceled})
}

// handleDownloadsBulk applies pause/resume/cancel/delete to the caller's
// matching downloads — all of them, or only the given ids (multi-select).
func (s *Server) handleDownloadsBulk(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		Action string  `json:"action"`
		IDs    []int64 `json:"ids"` // empty = every matching download
	}
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
		writeJSON(w, http.StatusOK, map[string]int64{"affected": n})
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
	writeJSON(w, http.StatusOK, map[string]int{"affected": affected})
}

// handleGlobalRateLimit sets the global transfer limit (bytes/s, 0 =
// unlimited) without going through the full settings payload — the
// dashboard's quick control. Admin only.
func (s *Server) handleGlobalRateLimit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RateLimit int64 `json:"rateLimit"`
	}
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
	writeJSON(w, http.StatusOK, map[string]int64{"rateLimit": in.RateLimit})
}

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
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func (s *Server) handleDownloadRateLimit(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var in struct {
		RateLimit int64 `json:"rateLimit"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.Transfers.SetRateLimit(u.ID, id, in.RateLimit); err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleEvents streams download progress as SSE.
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
