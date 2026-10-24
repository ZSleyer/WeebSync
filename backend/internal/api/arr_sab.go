package api

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The download client half: just enough of the SABnzbd API for Sonarr and
// Radarr to hand over a grab, follow it and import the result. A job is one
// ordinary WeebSync download, so it shows up in the queue like any other.

// handleSab dispatches on mode, the way SABnzbd's single endpoint does.
func (s *Server) handleSab(w http.ResponseWriter, r *http.Request) {
	switch mode := r.FormValue("mode"); mode {
	case "version":
		writeJSON(w, http.StatusOK, map[string]string{"version": "4.3.3"})
	case "get_config":
		s.sabConfig(w)
	case "addfile", "addurl":
		s.sabAdd(w, r)
	case "queue":
		s.sabQueue(w, r)
	case "history":
		s.sabHistory(w, r)
	case "fullstatus", "status":
		writeJSON(w, http.StatusOK, map[string]any{"status": map[string]any{"paused": false, "completedir": s.arrAppPath(s.arrCompleteDir())}})
	default:
		slog.Debug("sab api", "mode", logSafe(mode), "reason", "not implemented")
		writeJSON(w, http.StatusOK, map[string]any{"status": false, "error": "not implemented"})
	}
}

// sabCategories are the categories offered: the apps' defaults, plus every
// one a job already used, so whatever the app is configured with exists.
func (s *Server) sabCategories() []string {
	cats := []string{"*", "tv", "movies", "sonarr", "radarr", "tv-sonarr", "anime"}
	rows, err := s.DB.Query(`SELECT DISTINCT category FROM arr_jobs WHERE category != ''`)
	if err != nil {
		return cats
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		if rows.Scan(&c) == nil && !slices.Contains(cats, c) {
			cats = append(cats, c)
		}
	}
	_ = rows.Err() // a cut-off read keeps the defaults plus what was read
	return cats
}

func (s *Server) sabConfig(w http.ResponseWriter) {
	complete := s.arrCompleteDir()
	if complete == "" {
		// an empty complete_dir reads to the app as a folder named after the
		// category ("/anime"), and every grab would fail later: say it in the
		// app's connection test instead, the way SABnzbd reports errors
		writeJSON(w, http.StatusOK, map[string]any{"status": false,
			"error": "WeebSync has no download folder for Sonarr/Radarr yet (Settings > Integrations > Sonarr / Radarr)"})
		return
	}
	var cats []map[string]any
	for i, c := range s.sabCategories() {
		dir := c
		if c == "*" {
			dir = ""
		}
		cats = append(cats, map[string]any{"name": c, "order": i, "dir": dir, "pp": "", "script": "Default", "priority": -100})
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": map[string]any{
		"misc": map[string]any{
			"complete_dir":         s.arrAppPath(complete),
			"enable_tv_sorting":    false,
			"enable_movie_sorting": false,
			"enable_date_sorting":  false,
			"pre_check":            false,
			"history_retention":    "",
		},
		"categories": cats,
		"sorters":    []any{},
	}})
}

var nzbGuidRe = regexp.MustCompile(`type="weebsync-guid">([0-9a-f]{8,64})<`)

// sabAdd takes a grab: the nzb the indexer handed out (addfile) or its link
// (addurl). Either way only the guid is read from it; what to fetch and from
// where comes from arr_releases.
func (s *Server) sabAdd(w http.ResponseWriter, r *http.Request) {
	fail := func(msg string) {
		slog.Warn("sab add", "err", msg)
		writeJSON(w, http.StatusOK, map[string]any{"status": false, "error": msg})
	}
	var guid string
	if r.FormValue("mode") == "addurl" {
		if u, err := url.Parse(r.FormValue("name")); err == nil {
			guid = u.Query().Get("id")
		}
	} else {
		f, _, err := r.FormFile("name")
		if err != nil {
			f, _, err = r.FormFile("nzbfile")
		}
		if err != nil {
			fail("no nzb file")
			return
		}
		body, _ := io.ReadAll(io.LimitReader(f, 1<<20))
		f.Close()
		if m := nzbGuidRe.FindSubmatch(body); m != nil {
			guid = string(m[1])
		}
	}
	var serverID int64
	var remote, title string
	var size int64
	if err := s.DB.QueryRow(`SELECT server_id, remote_path, size, title FROM arr_releases WHERE guid = ?`, guid).
		Scan(&serverID, &remote, &size, &title); err != nil {
		fail("unknown release")
		return
	}
	complete := s.arrCompleteDir()
	if complete == "" {
		fail("no download folder set up for Sonarr/Radarr in WeebSync")
		return
	}
	cat := safeSegment(r.FormValue("cat"))
	jobDir := filepath.Join(complete, cat, safeSegment(title))
	owner, err := s.serverOwner(serverID)
	if err != nil {
		slog.Warn("sab add: server owner lookup failed", "server", serverID, "err", err)
		fail("server lookup failed")
		return
	}
	ext := path.Ext(remote)
	// the file is named like the release, so the app reads the same thing
	// from the file it imports as from the release it grabbed
	nameFn := func(string) string { return safeSegment(title) + ext }
	res, err := s.Transfers.Enqueue(owner, serverID, remote, jobDir, nameFn, nil, false, true, false)
	if err != nil {
		fail(err.Error())
		return
	}
	var dl int64
	switch {
	case len(res.IDs) > 0:
		dl = res.IDs[0]
	case res.Skipped > 0:
		// already in the job folder from an earlier grab: done at once
	default:
		fail("nothing to fetch (already queued, or the target refuses writes)")
		return
	}
	raw := make([]byte, 8)
	rand.Read(raw)
	nzo := "SABnzbd_nzo_" + hex.EncodeToString(raw)
	// a job id the app tracks but nothing here knows would never report done
	if _, err := s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, category, title, job_dir, size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		nzo, guid, dl, r.FormValue("cat"), title, jobDir, size); err != nil {
		slog.Warn("sab job not recorded", "release", logSafe(title), "err", err)
		fail("could not record the job")
		return
	}
	slog.Info("sab add", "release", logSafe(title), "download", dl)
	writeJSON(w, http.StatusOK, map[string]any{"status": true, "nzo_ids": []string{nzo}})
}

// safeSegment makes one path segment of a release title or category: no
// separators, nothing a filesystem refuses, never "." or "..".
func safeSegment(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(strings.Trim(s, "."))
	if s == "" {
		return "default"
	}
	return s
}

// serverOwner is the user a server belongs to, 0 when there is no such server.
func (s *Server) serverOwner(serverID int64) (int64, error) {
	var uid int64
	err := s.DB.QueryRow(`SELECT user_id FROM servers WHERE id = ?`, serverID).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return uid, err
}

// sabJob is an arr_jobs row joined with its download.
type sabJob struct {
	nzo, title, cat, jobDir, status, errMsg string
	downloadID, size, transferred, userID   int64
	createdAt, updatedAt                    string
}

// sabJobs fails rather than coming back short: a job missing from both the
// queue and the history looks to the app like a vanished download, which it
// marks failed, blocklists and grabs again.
func (s *Server) sabJobs() ([]sabJob, error) {
	rows, err := s.DB.Query(`SELECT j.nzo_id, j.title, j.category, j.job_dir, j.download_id, j.size, j.created_at,
			COALESCE(d.status, ''), COALESCE(d.error, ''), COALESCE(d.transferred, 0), COALESCE(d.user_id, 0), COALESCE(d.updated_at, j.created_at),
			COALESCE(d.local_path, '')
		FROM arr_jobs j LEFT JOIN downloads d ON d.id = j.download_id ORDER BY j.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sabJob
	for rows.Next() {
		var j sabJob
		var localPath string
		if err := rows.Scan(&j.nzo, &j.title, &j.cat, &j.jobDir, &j.downloadID, &j.size, &j.createdAt,
			&j.status, &j.errMsg, &j.transferred, &j.userID, &j.updatedAt, &localPath); err != nil {
			return nil, err
		}
		if j.downloadID != 0 && !arrJobOwns(j.jobDir, localPath) {
			// the download was removed, and its id may since belong to another
			// download: this job no longer has one
			j.downloadID, j.userID, j.transferred = 0, 0, 0
			if hasFiles(j.jobDir) {
				j.status = "done" // the file made it, only the record is gone
			} else {
				j.status, j.errMsg = "error", "the download was removed from WeebSync"
			}
		} else if j.downloadID == 0 {
			j.status = "done"
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// sabInQueue reports whether a job with this status is listed in the queue
// (not in the history).
func sabInQueue(status string) bool {
	return status == "queued" || status == "running" || status == "paused"
}

// hasFiles reports whether dir holds anything.
func hasFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

// sabValues reads the comma list of nzo ids a delete/pause names.
func sabValues(r *http.Request) map[string]bool {
	out := map[string]bool{}
	for _, v := range strings.Split(r.FormValue("value"), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out[v] = true
		}
	}
	return out
}

func (s *Server) sabQueue(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.sabJobs()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": false, "error": "job list unavailable"})
		return
	}
	switch r.FormValue("name") {
	case "delete":
		want := sabValues(r)
		for _, j := range jobs {
			// "all" empties the queue only, as in SABnzbd
			if want[j.nzo] || (want["all"] && sabInQueue(j.status)) {
				if j.downloadID > 0 && j.status != "done" {
					s.Transfers.Cancel(j.userID, j.downloadID)
				}
				if _, err := s.DB.Exec(`DELETE FROM arr_jobs WHERE nzo_id = ?`, j.nzo); err != nil {
					slog.Warn("sab delete: job not removed", "nzo", j.nzo, "err", err)
					writeJSON(w, http.StatusInternalServerError, map[string]any{"status": false, "error": "job not removed"})
					return
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": true})
		return
	case "pause", "resume":
		want := sabValues(r)
		for _, j := range jobs {
			if want[j.nzo] && j.downloadID > 0 {
				if r.FormValue("name") == "pause" {
					s.Transfers.Pause(j.userID, j.downloadID)
				} else {
					s.Transfers.Resume(j.userID, j.downloadID)
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": true})
		return
	}
	slots := []map[string]any{}
	for _, j := range jobs {
		st := map[string]string{"queued": "Queued", "running": "Downloading", "paused": "Paused"}[j.status]
		if st == "" {
			continue // finished: history
		}
		mb := float64(j.size) / (1 << 20)
		left := float64(j.size-j.transferred) / (1 << 20)
		pct := 0
		if j.size > 0 {
			pct = int(j.transferred * 100 / j.size)
		}
		slots = append(slots, map[string]any{
			"status": st, "index": len(slots), "timeleft": "0:00:00", "filename": j.title,
			"mb": strconv.FormatFloat(mb, 'f', 2, 64), "mbleft": strconv.FormatFloat(left, 'f', 2, 64),
			"percentage": strconv.Itoa(pct), "cat": j.cat, "priority": "Normal", "nzo_id": j.nzo,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"queue": map[string]any{
		"status": "Downloading", "paused": false, "speedlimit": "0", "slots": slots, "noofslots": len(slots),
	}})
}

func (s *Server) sabHistory(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.sabJobs()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"status": false, "error": "job list unavailable"})
		return
	}
	if r.FormValue("name") == "delete" {
		// the app forgets a job it imported; the files are its business now
		want := sabValues(r)
		for _, j := range jobs {
			// "all" empties the history only, as in SABnzbd
			if want[j.nzo] || (want["all"] && !sabInQueue(j.status)) {
				if _, err := s.DB.Exec(`DELETE FROM arr_jobs WHERE nzo_id = ?`, j.nzo); err != nil {
					slog.Warn("sab history delete: job not removed", "nzo", j.nzo, "err", err)
					writeJSON(w, http.StatusInternalServerError, map[string]any{"status": false, "error": "job not removed"})
					return
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": true})
		return
	}
	slots := []map[string]any{}
	for i := len(jobs) - 1; i >= 0; i-- { // newest first, as SABnzbd lists them
		j := jobs[i]
		var st, msg string
		switch j.status {
		case "done":
			st = "Completed"
		case "error", "canceled":
			st, msg = "Failed", j.errMsg
			if msg == "" {
				msg = "canceled in WeebSync"
			}
		default:
			continue // still in the queue
		}
		done, _ := time.Parse(sqliteTime, j.updatedAt)
		slots = append(slots, map[string]any{
			"nzo_id": j.nzo, "name": j.title, "nzb_name": j.title + ".nzb", "category": j.cat,
			"status": st, "fail_message": msg, "bytes": j.size, "download_time": 0,
			"completed": done.Unix(), "storage": s.arrAppPath(j.jobDir),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": map[string]any{"slots": slots, "noofslots": len(slots)}})
}
