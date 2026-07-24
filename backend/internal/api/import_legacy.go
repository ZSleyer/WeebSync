package api

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// LegacyImportRequest drives both phases of the import. With DryRun the old
// config is converted and returned untouched; the UI edits that plan and sends
// it back in Watches for the actual write.
type LegacyImportRequest struct {
	Config      legacyConfig      `json:"config"`      // parsed old weebsync.config.json
	DryRun      bool              `json:"dryRun"`      // true = preview only, no writes
	LocalRoot   string            `json:"localRoot"`   // destination folders are rebased onto this
	ServerID    int64             `json:"serverId"`    // reuse an existing server instead of creating one
	Server      *serverInput      `json:"server"`      // server to create (protocol/port/password confirmed by the user)
	IntervalMin int               `json:"intervalMin"` // global auto-sync interval to apply
	Watches     []LegacyWatchPlan `json:"watches"`     // the reviewed plan rows; empty on a dry run
}

// LegacyImportResult reports what the commit actually created.
type LegacyImportResult struct {
	ServerID int64    `json:"serverId"`
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

// handleLegacyImport converts a config file of the original Node weebsync into
// a server plus one watch per syncMap.
//
//	@Summary		Import a legacy weebsync config
//	@Description	Converts a config.json of the original Node weebsync (BastianGanze/weebsync) into a server and watches. With dryRun the conversion is only previewed; the reviewed plan is sent back to commit it.
//	@Tags			Import
//	@Accept			json
//	@Produce		json
//	@Param			body	body		LegacyImportRequest	true	"Old config plus import options"
//	@Success		200		{object}	LegacyPlan			"dry run: the conversion preview"
//	@Success		201		{object}	LegacyImportResult	"commit: what was created"
//	@Failure		400		{object}	ErrorResponse
//	@Failure		401		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/import/legacy [post]
func (s *Server) handleLegacyImport(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in LegacyImportRequest
	if !readJSON(w, r, &in) {
		return
	}

	if in.DryRun {
		writeJSON(w, http.StatusOK, convertLegacy(in.Config, in.LocalRoot))
		return
	}

	serverID := in.ServerID
	if serverID == 0 {
		if in.Server == nil || !in.Server.valid() || in.Server.Password == "" {
			writeErr(w, http.StatusBadRequest, "server (name, protocol, host, username, password) or serverId required")
			return
		}
		id, err := s.insertServer(u.ID, *in.Server)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		serverID = id
	} else {
		var owned int
		s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned)
		if owned == 0 {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
	}

	if in.IntervalMin >= 5 && in.IntervalMin <= 1440 {
		db.SetSetting(s.DB, "watch_interval_min", strconv.Itoa(in.IntervalMin))
	}

	out := LegacyImportResult{ServerID: serverID, Errors: []string{}}
	for _, p := range in.Watches {
		if err := s.importLegacyWatch(u.ID, serverID, p); err != nil {
			out.Skipped++
			out.Errors = append(out.Errors, p.ID+": "+err.Error())
			continue
		}
		out.Imported++
	}
	// no immediate per-watch sync: the watch loop picks fresh rows up on its
	// next tick and runs them sequentially, instead of dozens at once
	writeJSON(w, http.StatusCreated, out)
}

// importLegacyWatch validates one reviewed plan row and inserts it.
func (s *Server) importLegacyWatch(userID, serverID int64, p LegacyWatchPlan) error {
	if p.Mode == "" {
		p.Mode = "template"
	}
	if p.Mode != "template" && p.Mode != "regex" {
		return errBadMode
	}
	if p.RemotePath == "" {
		return errNoRemotePath
	}
	if _, err := s.safeLocal(p.LocalPath); err != nil {
		return err
	}
	if p.Mode == "regex" && p.Pattern != "" {
		if _, err := regexp.Compile(p.Pattern); err != nil {
			return err
		}
	}
	_, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, title_override, pattern, replacement, from_episode)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		userID, serverID, p.RemotePath, p.LocalPath, p.Mode, p.Template, p.TitleOverride, p.Pattern, p.Replacement, max(p.FromEpisode, 0))
	return err
}

var (
	errBadMode      = errors.New("invalid mode")
	errNoRemotePath = errors.New("remotePath required")
)
