package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// Detected marks: a folder mark WeebSync sets itself because the structure
// speaks for it (auto_marks.go). It is an ordinary row of catalog_scopes with
// detected_at set; every write by a user goes through handleCatalogScope, which
// stores a row with detected_at 0, so what a user decided is never mistaken
// for a detection and detection never writes over an existing row.

// detectedAt is when WeebSync marked a folder, in Unix milliseconds; 0 when
// the folder has no row or the mark is a user's.
func (s *Server) detectedAt(serverID int64, p string) (int64, error) {
	var at int64
	err := s.DB.QueryRow(`SELECT detected_at FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, p).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return at, err
}

// detectedMark is one mark WeebSync set, as the list shows it.
type detectedMark struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	Kind       string `json:"kind" enums:"anime,manga,tv,movie,tvdb,auto"`
	// when it was marked, Unix milliseconds
	DetectedAt int64 `json:"detectedAt"`
	// marked after the user last looked at the list
	Unseen bool `json:"unseen"`
}

// detectedMarksResponse is the list of detected marks, newest first.
type detectedMarksResponse struct {
	Items []detectedMark `json:"items"`
	// how many of them the user has not seen yet
	Unseen int `json:"unseen"`
}

// seenKey is the setting that holds when a user last looked at the list.
func seenKey(userID int64) string { return fmt.Sprintf("detected_marks_seen:%d", userID) }

// detectedSeenAt is when the user last opened the list (Unix ms), 0 for never.
// A value that does not read counts as never: the list then shows everything
// as new, which is the safe side.
func (s *Server) detectedSeenAt(userID int64) int64 {
	v, err := db.SettingErr(s.DB, seenKey(userID))
	if err != nil {
		return 0
	}
	at, err := strconv.ParseInt(v, 10, 64)
	if err != nil || at < 0 {
		return 0
	}
	return at
}

// handleDetectedMarks lists the marks WeebSync set on the user's servers.
//
//	@Summary		Folders marked automatically
//	@Description	The folder marks WeebSync set itself (a folder of single titles, a new season folder beside marked ones), newest first. A mark the user changes, sets to none or removes is no longer listed. unseen counts those marked after the list was last marked seen.
//	@Tags			Catalog
//	@Produce		json
//	@Success		200	{object}	detectedMarksResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/catalog/detected-marks [get]
func (s *Server) handleDetectedMarks(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	seen := s.detectedSeenAt(u.ID)
	rows, err := s.DB.Query(`SELECT cs.server_id, sv.name, cs.path, cs.kind, cs.detected_at FROM catalog_scopes cs
		JOIN servers sv ON sv.id = cs.server_id
		WHERE sv.user_id = ? AND cs.detected_at > 0 AND cs.kind != ?
		ORDER BY cs.detected_at DESC, cs.path`, u.ID, scopeNone)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	out := detectedMarksResponse{Items: []detectedMark{}}
	for rows.Next() {
		var m detectedMark
		if err := rows.Scan(&m.ServerID, &m.ServerName, &m.Path, &m.Kind, &m.DetectedAt); err != nil {
			dbErr(w)
			return
		}
		m.Name = path.Base(m.Path)
		m.Unseen = m.DetectedAt > seen
		if m.Unseen {
			out.Unseen++
		}
		out.Items = append(out.Items, m)
	}
	if rows.Err() != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDetectedMarksSeen records that the user has looked at the list, so
// the marks so far stop counting as new; later ones do.
//
//	@Summary		Mark the automatic marks as seen
//	@Tags			Catalog
//	@Produce		json
//	@Success		200	{object}	OkResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/catalog/detected-marks/seen [post]
func (s *Server) handleDetectedMarksSeen(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if err := db.SetSetting(s.DB, seenKey(u.ID), strconv.FormatInt(time.Now().UnixMilli(), 10)); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
