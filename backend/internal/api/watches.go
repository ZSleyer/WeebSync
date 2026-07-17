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
	"github.com/ch4d1/weebsync/internal/transfer"
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
	LastResult    string `json:"lastResult"`    // human-readable, display only
	LastUploading int    `json:"lastUploading"` // files still uploading remotely at the last check
	CreatedAt     string `json:"createdAt"`

	// enriched for the overview
	Media        *anilist.Media `json:"media,omitempty"`
	LocalFiles   int            `json:"localFiles"`
	Active       int            `json:"active"`                 // queued/running downloads for this watch
	Complete     bool           `json:"complete"`               // finished title, all episodes synced
	NextEpisode  int            `json:"nextEpisode,omitempty"`  // upcoming episode number (AniList)
	SeenEpisodes int            `json:"seenEpisodes,omitempty"` // watched episodes from the linked AniList list
	NextAiringAt int64          `json:"nextAiringAt,omitempty"` // unix seconds of its release
	Waiting      bool           `json:"waiting"`                // smart sync: idle until NextAiringAt
}

// videoExt: files counted as episodes for the completeness check.
// ponytail: extension heuristic; parsing episode numbers would be the upgrade.
var videoExt = transfer.VideoExt

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
// Watches with an AniList match sync smart: once every aired episode is
// local, checks pause until the next episode's release time (airingAt), then
// resume on the normal interval until the episode arrived.
func (s *Server) WatchLoop(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			interval := time.Duration(s.watchInterval()) * time.Minute
			rows, err := s.DB.Query(`SELECT id, server_id, remote_path, local_path, last_check FROM watches`)
			if err != nil {
				continue
			}
			type cand struct {
				id                               int64
				serverID                         int64
				remotePath, localPath, lastCheck string
			}
			var cands []cand
			for rows.Next() {
				var c cand
				rows.Scan(&c.id, &c.serverID, &c.remotePath, &c.localPath, &c.lastCheck)
				cands = append(cands, c)
			}
			rows.Close()
			now := time.Now()
			for _, c := range cands {
				intervalDue := true
				if t, err := time.Parse("2006-01-02 15:04:05", c.lastCheck); err == nil {
					intervalDue = !t.Add(interval).After(now.UTC())
				}
				media := s.watchMedia(c.serverID, c.remotePath)
				have := s.countVideos(path.Join(c.localPath, path.Base(c.remotePath)))
				if smartDue(intervalDue, media, have, now) {
					s.runWatch(c.id)
				}
			}
		}
	}
}

// smartDue decides whether a watch should check now. Without an AniList
// airing schedule the plain interval rule applies. With one, a watch that
// already holds every aired episode stays idle until the next episode's
// release time.
func smartDue(intervalDue bool, media *anilist.Media, haveEps int, now time.Time) bool {
	if !intervalDue {
		return false
	}
	if media == nil || media.NextAiring == nil {
		return true
	}
	if haveEps >= media.NextAiring.Episode-1 && now.Unix() < media.NextAiring.AiringAt {
		return false // all aired episodes synced, wait for the release slot
	}
	return true
}

// watchMedia returns the metadata match of a watched folder (AniList or
// TMDB, depending on the stored source), refreshing stale non-finished
// entries in the background (release schedules move).
func (s *Server) watchMedia(serverID int64, remotePath string) *anilist.Media {
	var id int
	var source string
	s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
		serverID, remotePath).Scan(&id, &source)
	if id == 0 {
		return nil
	}
	m, _ := s.sourceMedia(source, id)
	return m
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

	ids, uploading, err := s.Transfers.Enqueue(w.UserID, w.ServerID, w.RemotePath, w.LocalPath, watchNameFn(w), true, false)
	queued := len(ids)
	result := fmt.Sprintf("%d neu", queued)
	if uploading > 0 {
		result = fmt.Sprintf("%d neu, %d im Upload", queued, uploading)
	}
	if err != nil {
		result = err.Error()
		uploading = 0
		slog.Warn("watch check", "id", id, "err", err)
	}
	s.DB.Exec(`UPDATE watches SET last_result = ?, last_uploading = ? WHERE id = ?`, result, uploading, id)
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
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.last_check, w.last_result, w.last_uploading, w.created_at
		FROM watches w JOIN servers s ON s.id = w.server_id
		WHERE w.user_id = ? ORDER BY w.id DESC`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	progress := s.anilistProgress(u.ID)
	list := []Watch{}
	for rows.Next() {
		var it Watch
		if err := rows.Scan(&it.ID, &it.UserID, &it.ServerID, &it.ServerName, &it.RemotePath, &it.LocalPath,
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement,
			&it.LastCheck, &it.LastResult, &it.LastUploading, &it.CreatedAt); err != nil {
			dbErr(w)
			return
		}
		it.IntervalMin = interval
		it.Media = s.watchMedia(it.ServerID, it.RemotePath)
		it.LocalFiles = s.countVideos(path.Join(it.LocalPath, path.Base(it.RemotePath)))
		s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ?
			AND status IN ('queued','running','paused') AND remote_path LIKE ? || '%'`,
			u.ID, it.ServerID, it.RemotePath).Scan(&it.Active)
		it.Complete = it.Media != nil && it.Media.Status == "FINISHED" && it.Media.Episodes > 0 &&
			it.LocalFiles >= it.Media.Episodes && it.Active == 0
		if it.Media != nil {
			it.SeenEpisodes = progress[it.Media.ID]
		}
		if it.Media != nil && it.Media.NextAiring != nil {
			it.NextEpisode = it.Media.NextAiring.Episode
			it.NextAiringAt = it.Media.NextAiring.AiringAt
			it.Waiting = !smartDue(true, it.Media, it.LocalFiles, time.Now())
		}
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
	id := pathID(r)
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
	id := pathID(r)
	res, err := s.DB.Exec(`DELETE FROM watches WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		dbErr(w)
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
	id := pathID(r)
	// machine token (admin-scoped) may trigger any watch; sessions only their own
	q, args := `SELECT COUNT(*) FROM watches WHERE id = ?`, []any{id}
	if !isMachine(r.Context()) {
		q += ` AND user_id = ?`
		args = append(args, auth.UserFrom(r.Context()).ID)
	}
	var owned int
	s.DB.QueryRow(q, args...).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	go s.runWatch(id)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "checking"})
}
