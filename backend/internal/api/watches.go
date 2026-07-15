package api

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/rename"
)

// Watch is a persistent remote-folder subscription: the folder is re-checked
// on an interval and new/changed files are downloaded automatically,
// optionally renamed via template.
type Watch struct {
	ID            int64  `json:"id"`
	UserID        int64  `json:"userId"`
	ServerID      int64  `json:"serverId"`
	ServerName    string `json:"serverName"`
	RemotePath    string `json:"remotePath"`
	LocalPath     string `json:"localPath"`
	Mode          string `json:"mode"` // "template" | "regex"
	Template      string `json:"template"`
	Separator     string `json:"separator"`
	TitleOverride string `json:"titleOverride"`
	Pattern       string `json:"pattern"`
	Replacement   string `json:"replacement"`
	IntervalMin   int    `json:"intervalMin"` // global setting, echoed for the UI
	LastCheck     string `json:"lastCheck"`
	LastResult    string `json:"lastResult"`
	CreatedAt     string `json:"createdAt"`

	// enriched for the overview
	Media      *anilist.Media `json:"media,omitempty"`
	LocalFiles int            `json:"localFiles"`
	Active     int            `json:"active"`   // queued/running downloads for this watch
	Complete   bool           `json:"complete"` // finished title, all episodes synced
}

// videoExt: files counted as episodes for the completeness check.
// ponytail: extension heuristic; parsing episode numbers would be the upgrade.
var videoExt = map[string]bool{".mkv": true, ".mp4": true, ".avi": true, ".ts": true, ".m2ts": true, ".webm": true, ".mov": true}

// watchInterval returns the global check interval in minutes
// (setting "watch_interval_min", default 30, minimum 5).
func (s *Server) watchInterval() int {
	n, _ := strconv.Atoi(db.Setting(s.DB, "watch_interval_min"))
	if n < 5 {
		return 30
	}
	return n
}

// WatchLoop periodically runs due watches; the interval is a global setting.
// A manual check updates last_check, which naturally resets the countdown.
func (s *Server) WatchLoop(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			rows, err := s.DB.Query(`SELECT id FROM watches
				WHERE last_check = '' OR datetime(last_check, ?) <= datetime('now')`,
				fmt.Sprintf("+%d minutes", s.watchInterval()))
			if err != nil {
				continue
			}
			var due []int64
			for rows.Next() {
				var id int64
				rows.Scan(&id)
				due = append(due, id)
			}
			rows.Close()
			for _, id := range due {
				s.runWatch(id)
			}
		}
	}
}

// runWatch checks one watch now: stamps last_check first (self-reset), then
// enqueues missing/changed files through the normal transfer queue.
func (s *Server) runWatch(id int64) {
	var w Watch
	err := s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement
		FROM watches WHERE id = ?`, id).
		Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator, &w.TitleOverride, &w.Pattern, &w.Replacement)
	if err != nil {
		return
	}
	s.DB.Exec(`UPDATE watches SET last_check = datetime('now') WHERE id = ?`, id)

	queued, err := s.Transfers.Enqueue(w.UserID, w.ServerID, w.RemotePath, w.LocalPath, watchNameFn(w))
	result := fmt.Sprintf("%d neu", queued)
	if err != nil {
		result = err.Error()
		slog.Warn("watch check", "id", id, "err", err)
	}
	s.DB.Exec(`UPDATE watches SET last_result = ? WHERE id = ?`, result, id)
}

// watchNameFn maps remote file names to local ones via the watch's rename
// rule (template or regex); unparseable names keep their original.
func watchNameFn(w Watch) func(string) string {
	o := rename.Options{
		Mode: w.Mode, Template: w.Template, Separator: w.Separator,
		TitleOverride: w.TitleOverride, Pattern: w.Pattern, Replacement: w.Replacement,
	}
	if o.Mode == "" {
		o.Mode = "template"
	}
	if (o.Mode == "template" && o.Template == "") || (o.Mode == "regex" && o.Pattern == "") {
		return nil // no rename configured
	}
	return func(name string) string {
		n, err := rename.New(name, o)
		if err != nil || n == "" {
			return name
		}
		return n
	}
}

func (s *Server) handleWatchesList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	interval := s.watchInterval()
	rows, err := s.DB.Query(`SELECT w.id, w.user_id, w.server_id, s.name, w.remote_path, w.local_path,
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.last_check, w.last_result, w.created_at
		FROM watches w JOIN servers s ON s.id = w.server_id
		WHERE w.user_id = ? ORDER BY w.id DESC`, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	list := []Watch{}
	for rows.Next() {
		var it Watch
		if err := rows.Scan(&it.ID, &it.UserID, &it.ServerID, &it.ServerName, &it.RemotePath, &it.LocalPath,
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement,
			&it.LastCheck, &it.LastResult, &it.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		it.IntervalMin = interval
		// AniList match of the watched folder, if the catalog knows it
		var mediaID int
		s.DB.QueryRow(`SELECT media_id FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
			it.ServerID, it.RemotePath).Scan(&mediaID)
		if mediaID != 0 {
			it.Media, _ = s.Anilist.CachedMedia(mediaID)
		}
		it.LocalFiles = s.countVideos(path.Join(it.LocalPath, path.Base(it.RemotePath)))
		s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ?
			AND status IN ('queued','running','paused') AND remote_path LIKE ? || '%'`,
			u.ID, it.ServerID, it.RemotePath).Scan(&it.Active)
		it.Complete = it.Media != nil && it.Media.Status == "FINISHED" && it.Media.Episodes > 0 &&
			it.LocalFiles >= it.Media.Episodes && it.Active == 0
		list = append(list, it)
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) countVideos(rel string) int {
	abs, err := s.safeLocal(rel)
	if err != nil {
		return 0
	}
	n := 0
	filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
			n++
		}
		return nil
	})
	return n
}

func (s *Server) handleWatchCreate(w http.ResponseWriter, r *http.Request) {
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
	if in.Mode == "" {
		in.Mode = "template"
	}
	if in.Mode != "template" && in.Mode != "regex" {
		writeErr(w, http.StatusBadRequest, "invalid mode")
		return
	}
	res, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.ServerID, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	id, _ := res.LastInsertId()
	go s.runWatch(id) // first sync right away
	writeJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func (s *Server) handleWatchUpdate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in struct {
		RemotePath    string `json:"remotePath"`
		LocalPath     string `json:"localPath"`
		Mode          string `json:"mode"`
		Template      string `json:"template"`
		Separator     string `json:"separator"`
		TitleOverride string `json:"titleOverride"`
		Pattern       string `json:"pattern"`
		Replacement   string `json:"replacement"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.RemotePath == "" {
		writeErr(w, http.StatusBadRequest, "remotePath required")
		return
	}
	if _, err := s.safeLocal(in.LocalPath); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Mode == "" {
		in.Mode = "template"
	}
	if in.Mode != "template" && in.Mode != "regex" {
		writeErr(w, http.StatusBadRequest, "invalid mode")
		return
	}
	var oldRemote, oldLocal string
	if err := s.DB.QueryRow(`SELECT remote_path, local_path FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).
		Scan(&oldRemote, &oldLocal); err != nil {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	_, err := s.DB.Exec(`UPDATE watches SET remote_path = ?, local_path = ?, mode = ?, template = ?, separator = ?, title_override = ?, pattern = ?, replacement = ?
		WHERE id = ? AND user_id = ?`, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, id, u.ID)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	if in.RemotePath != oldRemote || in.LocalPath != oldLocal {
		go s.runWatch(id) // paths changed: check the new folder right away
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleWatchDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	res, err := s.DB.Exec(`DELETE FROM watches WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleWatchCheck triggers a manual check; last_check is stamped inside
// runWatch, so the 30min countdown restarts from now.
func (s *Server) handleWatchCheck(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	go s.runWatch(id)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "checking"})
}
