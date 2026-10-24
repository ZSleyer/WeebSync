package api

import (
	"encoding/json"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/rename"
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
	// Lang is the language step: what the file carries and what the watch
	// asked for. Absent when neither is known.
	Lang *watchLastLang `json:"lang,omitempty"`
	// Replaced is the version step: the file name of the older copy this one
	// moved into the trash folder (an upgrade sync, a v2 over its v1). Absent
	// when it replaced nothing or the trash has been emptied since.
	Replaced string `json:"replaced,omitempty"`
}

// watchLastLang is the language decision for the newest file.
type watchLastLang struct {
	// Dub and Sub are the audio and subtitle languages as app language codes
	// ("Ger", "Jap").
	Dub []string `json:"dub,omitempty"`
	Sub []string `json:"sub,omitempty"`
	// From says where they were read: name is the file's (or its folder's)
	// language tags, probe the tracks a header probe of the remote file found.
	From string `json:"from,omitempty" enums:"name,probe"`
	// WantDub and WantSub are the watch's language filter the file passed.
	WantDub string `json:"wantDub,omitempty"`
	WantSub string `json:"wantSub,omitempty"`
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
//	@Description	The reason a watch waits, its newest file with the language it carried and the older copy it replaced, and the files its last check did not queue.
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
	if err := s.DB.QueryRow(`SELECT last_check, retry_at, check_attempts, last_filtered, last_skips, from_episode FROM watches WHERE id = ?`, wt.ID).
		Scan(&lastCheck, &retryAt, &attempts, &filtered, &skipsJSON, &fromEpisode); err != nil {
		dbErr(w, err)
		return
	}
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
	var replaceOld bool
	under, underArgs := subtreeCond("remote_path", wt.RemotePath)
	if err := s.DB.QueryRow(`SELECT remote_path, local_path, size, updated_at, replace_old FROM downloads
		WHERE user_id = ? AND server_id = ? AND status = 'done' AND `+under+`
		ORDER BY updated_at DESC, id DESC LIMIT 1`, append([]any{u.ID, wt.ServerID}, underArgs...)...).
		Scan(&last.Remote, &last.Local, &last.Size, &last.At, &replaceOld); err == nil {
		last.Lang = s.lastFileLang(wt, last.Remote)
		if replaceOld {
			last.Replaced = s.replacedCopy(last.Local, last.At)
		}
		out.Last = &last
	}
	writeJSON(w, http.StatusOK, out)
}

// lastFileLang reads the languages of a downloaded remote file the way the
// watch's language filter does: the name tags first, the cached track probe
// where a wanted language (or every language) has no tag. It never dials:
// a probe that is not cached is not made for an explanation.
func (s *Server) lastFileLang(wt Watch, remote string) *watchLastLang {
	var l watchLastLang
	// a manga watch ignores the language filter, so it did not pass one
	if (wt.WantDub != "" || wt.WantSub != "") && !s.isMangaWatch(wt) {
		l.WantDub, l.WantSub = wt.WantDub, wt.WantSub
	}
	dubTag, subTag := rename.PathLangTags(remote)
	ambiguous := (l.WantDub != "" && dubTag == "") || (l.WantSub != "" && subTag == "")
	if ambiguous || (dubTag == "" && subTag == "") {
		if dub, sub, ok := s.cachedRemoteLang(wt.ServerID, remote); ok {
			delete(dub, undLang)
			delete(sub, undLang)
			l.Dub, l.Sub, l.From = keysSorted(dub), keysSorted(sub), "probe"
		}
	}
	if l.From == "" {
		l.Dub, l.Sub = tagLangs(dubTag), tagLangs(subTag)
		if len(l.Dub)+len(l.Sub) > 0 {
			l.From = "name"
		}
	}
	if len(l.Dub) == 0 {
		l.Dub = nil
	}
	if len(l.Sub) == 0 {
		l.Sub = nil
	}
	if l.From == "" && l.WantDub == "" && l.WantSub == "" {
		return nil
	}
	return &l
}

// tagLangs splits a composed name tag ("GerJapDub") into app language codes
// (Ger, Jap), in tag order and without repeats.
func tagLangs(tag string) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range rename.Codes(tag) {
		if code := langCode(c); code != "" && !seen[code] {
			seen[code] = true
			out = append(out, code)
		}
	}
	return out
}

// replacedWindow is how far apart a download's finish and the trashing of the
// copy it displaced may lie: the upgrade hook runs right after the finish, so
// anything further off was trashed by something else.
const replacedWindow = 10 * time.Minute

// replacedCopy names the older copy an upgrade download moved aside: the
// video in the trash folder beside it that is the same episode and was
// trashed closest to the download's finish. "" when the trash holds none.
func (s *Server) replacedCopy(local, finished string) string {
	at, err := time.Parse("2006-01-02 15:04:05", finished)
	if err != nil {
		return ""
	}
	prefix := filepath.Join(filepath.Dir(local), trashDir) + string(filepath.Separator)
	se, ep := 0, 0
	if m := epSeasonRe.FindStringSubmatch(filepath.Base(local)); m != nil {
		se, _ = strconv.Atoi(m[1])
		ep, _ = strconv.Atoi(m[2])
	}
	rows, err := s.DB.Query(`SELECT path, trashed_at FROM trash_files
		WHERE substr(path, 1, ?) = ? AND trashed_at BETWEEN ? AND ?`,
		len(prefix), prefix, at.Add(-replacedWindow).Unix(), at.Add(replacedWindow).Unix())
	if err != nil {
		return ""
	}
	defer rows.Close()
	best, bestGap := "", int64(-1)
	for rows.Next() {
		var p string
		var trashed int64
		if rows.Scan(&p, &trashed) != nil {
			continue
		}
		name := p[len(prefix):]
		if strings.ContainsRune(name, filepath.Separator) || !videoExt[strings.ToLower(filepath.Ext(name))] {
			continue
		}
		if ep > 0 && !sameEpisode(name, se, ep) {
			continue
		}
		gap := trashed - at.Unix()
		if gap < 0 {
			gap = -gap
		}
		if bestGap < 0 || gap < bestGap {
			best, bestGap = name, gap
		}
	}
	if rows.Err() != nil {
		return ""
	}
	return best
}
