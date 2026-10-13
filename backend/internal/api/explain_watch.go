package api

import (
	"encoding/json"
	"net/http"
	"path"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// watchWait is what a watch is waiting for, as one reason.
type watchWait struct {
	// retry_backoff: the last check failed, the next one comes early
	// lang_backlog: files wait for their language, checks stay on the interval
	// until_slot: every aired episode is here, nothing happens before the slot
	// finished_idle: finished and complete, only the stale re-check remains
	// interval: the plain interval
	Reason      string `json:"reason" enums:"retry_backoff,lang_backlog,until_slot,finished_idle,interval"`
	At          int64  `json:"at"`                // unix seconds of the next check
	Slot        int64  `json:"slot,omitempty"`    // until_slot: the airing time
	Episode     int    `json:"episode,omitempty"` // until_slot: the local episode number
	Attempts    int    `json:"attempts,omitempty"`
	Filtered    int    `json:"filtered,omitempty"`
	Stale       int64  `json:"stale"` // the 12-hour re-check for upgrades
	IntervalMin int    `json:"intervalMin"`
}

// watchLastFile is the newest file a watch brought in.
type watchLastFile struct {
	Remote string `json:"remote"`
	Local  string `json:"local"`
	Size   int64  `json:"size"`
	At     string `json:"at"`
}

// watchExplainResponse explains one watch: why it waits, how its last file
// came in, and what its last check left on the server.
type watchExplainResponse struct {
	Wait      watchWait       `json:"wait"`
	LastCheck string          `json:"lastCheck"`
	Last      *watchLastFile  `json:"last"`
	Template  string          `json:"template"`
	Skips     []transfer.Skip `json:"skips"`
}

// waitReason names what decides the next check, in the order nextCheckAt and
// smartDue apply it: a failed check's backoff wins, a language backlog keeps
// the interval, a caught-up watch sleeps until the slot or, with no schedule
// left, until the stale re-check.
func waitReason(retryAt int64, filtered int, waiting bool, airingAt int64) string {
	switch {
	case retryAt > 0:
		return "retry_backoff"
	case filtered > 0:
		return "lang_backlog"
	case waiting && airingAt > 0:
		return "until_slot"
	case waiting:
		return "finished_idle"
	default:
		return "interval"
	}
}

// handleWatchExplain says why a watch does what it does.
//
//	@Summary		Explain a watch
//	@Description	The reason a watch waits, its newest file and the files its last check did not queue.
//	@Tags			Watches
//	@Produce		json
//	@Param			id	path		int	true	"Watch id"
//	@Success		200	{object}	watchExplainResponse
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/watches/{id}/explain [get]
func (s *Server) handleWatchExplain(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	wt, ok := s.loadWatch(pathID(r))
	if !ok || wt.UserID != u.ID {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	var lastCheck, skipsJSON string
	var retryAt int64
	var attempts, filtered, fromEpisode int
	s.DB.QueryRow(`SELECT last_check, retry_at, check_attempts, last_filtered, last_skips, from_episode FROM watches WHERE id = ?`, wt.ID).
		Scan(&lastCheck, &retryAt, &attempts, &filtered, &skipsJSON, &fromEpisode)
	out := watchExplainResponse{LastCheck: lastCheck, Template: wt.Template, Skips: []transfer.Skip{}}
	json.Unmarshal([]byte(skipsJSON), &out.Skips)

	interval := s.watchInterval()
	media := s.watchMedia(wt.ServerID, wt.RemotePath)
	local := wt.LocalPath
	if wt.Subfolder {
		local = path.Join(wt.LocalPath, path.Base(wt.RemotePath))
	}
	minEp := fromEpisode
	if wt.AiredMapping {
		minEp = 0
	}
	have := s.countVideos(local, minEp)
	offset := watchOffset(wt.Template)
	now := time.Now()
	waiting := !smartDue(true, media, have, offset, fromEpisode, filtered, wt.AiredMapping, watchComplete(media, have), now)
	var airingAt int64
	if media != nil && media.NextAiring != nil {
		airingAt = media.NextAiring.AiringAt
	}
	out.Wait = watchWait{
		At:          nextCheckAt(lastCheck, time.Duration(interval)*time.Minute, waiting, airingAt, retryAt, now),
		IntervalMin: interval,
	}
	if last, err := time.Parse("2006-01-02 15:04:05", lastCheck); err == nil {
		out.Wait.Stale = last.Add(staleRecheck).Unix()
	}
	out.Wait.Reason = waitReason(retryAt, filtered, waiting, airingAt)
	switch out.Wait.Reason {
	case "retry_backoff":
		out.Wait.Attempts = attempts
	case "lang_backlog":
		out.Wait.Filtered = filtered
	case "until_slot":
		out.Wait.Slot, out.Wait.Episode = airingAt, media.NextAiring.Episode+offset
	}

	var last watchLastFile
	if err := s.DB.QueryRow(`SELECT remote_path, local_path, size, updated_at FROM downloads
		WHERE user_id = ? AND server_id = ? AND status = 'done' AND remote_path LIKE ? || '%'
		ORDER BY updated_at DESC, id DESC LIMIT 1`, u.ID, wt.ServerID, wt.RemotePath).
		Scan(&last.Remote, &last.Local, &last.Size, &last.At); err == nil {
		out.Last = &last
	}
	writeJSON(w, http.StatusOK, out)
}
