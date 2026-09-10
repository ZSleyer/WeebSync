package api

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

// mountSources maps every mount point to the device it is mounted from, read
// from /proc/self/mountinfo. It is what tells two btrfs subvolumes of one
// drive apart from two drives: the kernel gives each subvolume a device
// number and a statfs id of its own, but both come from the same /dev node.
// Missing or unreadable (not Linux, AppArmor), the map is empty.
func mountSources() map[string]string {
	out := map[string]string{}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// mountID parentID major:minor root mountpoint opts [tags...] - fstype source superopts
		fields := strings.Fields(sc.Text())
		sep := slices.Index(fields, "-")
		if sep < 5 || sep+2 >= len(fields) {
			continue
		}
		mp := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(fields[4])
		out[mp] = fields[sep+2]
	}
	return out
}

// mountSource is the device behind a path, "" when it is unknown or not a
// device node (tmpfs, overlay and the like share one name across mounts).
func mountSource(mounts map[string]string, p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	best, src := -1, ""
	for mp, dev := range mounts {
		if (abs == mp || strings.HasPrefix(abs, strings.TrimSuffix(mp, "/")+"/")) && len(mp) > best {
			best, src = len(mp), dev
		}
	}
	if !strings.HasPrefix(src, "/dev/") {
		return ""
	}
	return src
}

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
	// Paths are the other library paths on this same filesystem
	Paths []string `json:"paths,omitempty"`
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
// there. The same filesystem seen through several paths is reported once,
// under its shortest path with the others listed, which is what folds the
// root's plain folders back into the root and a Plex root into its drive.
// Drives are told apart by the device they are mounted from: a btrfs
// subvolume carries a device number and a statfs id of its own, so either
// would count every subvolume as a drive. Where the mount table says nothing
// the statfs id stands in, and the device number where that is zero.
func (s *Server) diskUsage() []statusDisk {
	mounts := mountSources()
	paths := append([]string{s.DownloadRoot}, s.localRoots()...)
	if entries, err := os.ReadDir(s.DownloadRoot); err == nil {
		for _, e := range entries {
			if e.IsDir() || e.Type()&os.ModeSymlink != 0 {
				paths = append(paths, filepath.Join(s.DownloadRoot, e.Name()))
			}
		}
	}
	index := map[string]int{}
	var out []statusDisk
	for _, p := range paths {
		// best effort - a missing mount must not break the endpoint
		info, err := os.Stat(p)
		if err != nil || !info.IsDir() {
			continue
		}
		var st syscall.Statfs_t
		if syscall.Statfs(p, &st) != nil {
			continue
		}
		key := mountSource(mounts, p)
		if key == "" {
			key = fmt.Sprintf("fsid:%d:%d", st.Fsid.X__val[0], st.Fsid.X__val[1])
			if st.Fsid.X__val[0] == 0 && st.Fsid.X__val[1] == 0 {
				if sys, ok := info.Sys().(*syscall.Stat_t); ok {
					key = fmt.Sprintf("dev:%d", sys.Dev)
				}
			}
		}
		if i, ok := index[key]; ok {
			d := &out[i]
			if p == d.Path || slices.Contains(d.Paths, p) {
				continue
			}
			// the shortest path names the drive, the rest hang under it
			if len(p) < len(d.Path) {
				d.Paths = append(d.Paths, d.Path)
				d.Path = p
			} else {
				d.Paths = append(d.Paths, p)
			}
			continue
		}
		index[key] = len(out)
		bsize := uint64(st.Bsize)
		out = append(out, statusDisk{
			Path:       p,
			TotalBytes: st.Blocks * bsize,
			FreeBytes:  st.Bavail * bsize,
			UsedBytes:  (st.Blocks - st.Bfree) * bsize,
		})
	}
	// a plain folder under the root is not a path worth listing: only what
	// was named as a root or points elsewhere says something
	for i := range out {
		if out[i].Path == s.DownloadRoot {
			out[i].Paths = slices.DeleteFunc(out[i].Paths, func(p string) bool {
				rel, err := filepath.Rel(s.DownloadRoot, p)
				return err == nil && !strings.Contains(rel, string(filepath.Separator)) && !slices.Contains(s.localRoots(), p)
			})
		}
		slices.Sort(out[i].Paths)
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
