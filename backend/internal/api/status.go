package api

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"syscall"
)

type statusRunning struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	Size        int64   `json:"size"`
	Transferred int64   `json:"transferred"`
	BytesPerSec int64   `json:"bytesPerSec"`
	Progress    float64 `json:"progress"`
}

type statusFinished struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// ErrorCode is the classified reason (see transfer.classifyError); empty
	// for a success or an unrecognized failure.
	ErrorCode  string `json:"errorCode,omitempty"`
	FinishedAt string `json:"finishedAt"`
}

// statusContainer is the identity the process writes files as. A permission
// failure on a mounted media directory is only actionable once the user knows
// which UID to grant write access to, and nothing inside the container can be
// inferred from the outside.
type statusContainer struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

type statusWatch struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	LastCheck  string `json:"lastCheck"`
	LastResult string `json:"lastResult"`
}

type statusDisk struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
	UsedBytes  uint64 `json:"usedBytes"`
}

// StatusResponse is the aggregate machine-readable status payload: current
// downloads, the last finished ones, watch check summaries and disk usage.
type StatusResponse struct {
	Downloads struct {
		Active  int             `json:"active"`
		Queued  int             `json:"queued"`
		Running []statusRunning `json:"running"`
	} `json:"downloads"`
	LastFinished []statusFinished `json:"lastFinished"`
	Watches      []statusWatch    `json:"watches"`
	// Disk is the download root's filesystem, kept for consumers that read
	// one value; Disks is every filesystem the library spans, the root first
	Disk      statusDisk      `json:"disk"`
	Disks     []statusDisk    `json:"disks"`
	Container statusContainer `json:"container"`
}

// diskUsage is one entry per filesystem the library lives on: the download
// root, every configured local root, and every directory directly under the
// root - a library reaches onto a second drive as a mount point or a symlink
// there. The same filesystem seen through two paths is reported once, under
// the first, which is what folds the root's plain folders back into it.
func (s *Server) diskUsage() []statusDisk {
	paths := append([]string{s.DownloadRoot}, s.localRoots()...)
	if entries, err := os.ReadDir(s.DownloadRoot); err == nil {
		for _, e := range entries {
			if e.IsDir() || e.Type()&os.ModeSymlink != 0 {
				paths = append(paths, filepath.Join(s.DownloadRoot, e.Name()))
			}
		}
	}
	seen := map[uint64]bool{}
	var out []statusDisk
	for _, p := range paths {
		// best effort - a missing mount must not break the endpoint
		info, err := os.Stat(p)
		if err != nil || !info.IsDir() {
			continue
		}
		dev := uint64(0)
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			dev = uint64(st.Dev)
		}
		if seen[dev] {
			continue
		}
		var st syscall.Statfs_t
		if syscall.Statfs(p, &st) != nil {
			continue
		}
		seen[dev] = true
		bsize := uint64(st.Bsize)
		out = append(out, statusDisk{
			Path:       p,
			TotalBytes: st.Blocks * bsize,
			FreeBytes:  st.Bavail * bsize,
			UsedBytes:  (st.Blocks - st.Bfree) * bsize,
		})
	}
	return out
}

// handleStatus is the aggregate machine-readable status (Home Assistant etc.):
// polled state instead of SSE, so a dumb REST sensor can consume it.
//
// @Summary      Aggregate status
// @Description  Machine-readable snapshot of downloads, recent finishes, watches and disk usage for polling consumers (Home Assistant etc.). Reachable with an admin session cookie or a machine API token.
// @Tags         Status
// @Produce      json
// @Success      200  {object}  StatusResponse
// @Failure      403  {object}  ErrorResponse  "admin session required (machine token is exempt)"
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Security     BearerAuth
// @Router       /api/status [get]
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	out := StatusResponse{}
	out.Downloads.Running = []statusRunning{}
	out.LastFinished = []statusFinished{}
	out.Watches = []statusWatch{}

	rates := s.Transfers.RunningRates()
	rows, err := s.DB.Query(`SELECT id, remote_path, status, size, transferred FROM downloads
		WHERE status IN ('queued','running','paused') ORDER BY id`)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var d statusRunning
		var remote string
		if rows.Scan(&d.ID, &remote, &d.Status, &d.Size, &d.Transferred) != nil {
			continue
		}
		d.Name = path.Base(remote)
		d.BytesPerSec = rates[d.ID]
		if d.Size > 0 {
			d.Progress = float64(d.Transferred) / float64(d.Size)
		}
		switch d.Status {
		case "running":
			out.Downloads.Active++
		case "queued":
			out.Downloads.Queued++
		}
		out.Downloads.Running = append(out.Downloads.Running, d)
	}
	rows.Close()

	// updated_at is stamped exactly when a download reaches done/error, so it
	// doubles as finishedAt - HA detects "new finish" by watching the newest entry
	rows, err = s.DB.Query(`SELECT id, remote_path, status, error, error_code, updated_at FROM downloads
		WHERE status IN ('done','error') ORDER BY updated_at DESC, id DESC LIMIT 10`)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var f statusFinished
		var remote string
		if rows.Scan(&f.ID, &remote, &f.Status, &f.Error, &f.ErrorCode, &f.FinishedAt) != nil {
			continue
		}
		f.Name = path.Base(remote)
		out.LastFinished = append(out.LastFinished, f)
	}
	rows.Close()

	rows, err = s.DB.Query(`SELECT id, title_override, remote_path, last_check, last_result, last_queued, last_uploading FROM watches ORDER BY id`)
	if err != nil {
		dbErr(w)
		return
	}
	for rows.Next() {
		var wch statusWatch
		var title, remote string
		var queued, uploading int
		if rows.Scan(&wch.ID, &title, &remote, &wch.LastCheck, &wch.LastResult, &queued, &uploading) != nil {
			continue
		}
		// external consumers (Home Assistant) have no i18n: compose an
		// English summary; errors keep the raw last_result text
		if wch.LastResult == "" && queued >= 0 {
			wch.LastResult = fmt.Sprintf("%d new", queued)
			if uploading > 0 {
				wch.LastResult += fmt.Sprintf(", %d uploading", uploading)
			}
		}
		wch.Name = title
		if wch.Name == "" {
			wch.Name = path.Base(remote)
		}
		out.Watches = append(out.Watches, wch)
	}
	rows.Close()

	// who the process writes as: the missing half of every "permission denied"
	// on a bind-mounted media directory
	out.Container.UID, out.Container.GID = os.Getuid(), os.Getgid()

	out.Disks = s.diskUsage()
	if out.Disks == nil {
		out.Disks = []statusDisk{}
	}
	out.Disk.Path = s.DownloadRoot
	if len(out.Disks) > 0 {
		out.Disk = out.Disks[0]
	}

	writeJSON(w, http.StatusOK, out)
}
