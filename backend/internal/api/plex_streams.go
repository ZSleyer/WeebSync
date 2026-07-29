package api

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/plex"
)

// Plex playback preference: after a watch download lands and Plex has indexed
// the file, select the episode's audio/subtitle streams (per the token's
// account). The queue decouples "download done" from "Plex has scanned it".

// plexStreamGiveUp drops a queue entry Plex never indexed (file deleted,
// library not scanned) instead of retrying forever.
const plexStreamGiveUp = 3 * 24 * time.Hour

// plexStreamMissGiveUp bounds the OTHER kind of waiting: the episode was found
// and set, but the file does not carry a language that was asked for. That is
// worth looking at again for a while, because a dub re-release overwrites the
// same path and Plex re-analyses it afterwards - and not worth looking at
// forever, because most of the time the release simply never had the track.
const plexStreamMissGiveUp = 2 * time.Hour

// subOff is the stored subtitle preference that means "turn subtitles off",
// as opposed to "" which means "leave whatever Plex picked". Both are real
// choices and neither can stand in for the other.
const subOff = "off"

// subChoice reads the stored subtitle preference. The forced variant is part of
// the choice, not something derived from the audio: a dub viewer usually wants
// signs only, a language learner wants the full text under the same dub, and
// there is no way to tell those two people apart from the languages alone.
//
//	""           leave Plex alone
//	"off"        no subtitles
//	"Ger"        the full German track
//	"Ger:forced" the forced German track
func subChoice(pref string) (code string, forced, off bool) {
	if pref == subOff {
		return "", false, true
	}
	code, variant, _ := strings.Cut(pref, ":")
	return code, variant == "forced", false
}

// pickStream returns the id of the BEST stream of typ (2 audio, 3 subtitle)
// matching the wanted app language code ("Ger", "Jap"), and whether that track
// is the variant that was asked for. id 0 = no preference, or the language is
// not in this file.
//
// The language alone does not identify a track. A file routinely carries two
// German subtitle tracks - one forced, for the foreign dialogue and signs you
// want on top of a German dub, and one full - and next to them can sit an SDH
// track; on the audio side a commentary or an audio-description track wears the
// same language as the real one. Taking the first language match returned
// whichever the muxer wrote first, and forced tracks are conventionally first.
//
// exact=false is not a failure, it is a substitution: the language is there but
// only in a variant nobody asked for, which is worth telling the user about
// while still being better than leaving Plex on its own default.
func pickStream(streams []plex.EpisodeStream, typ int, want string, wantForced bool) (id int64, exact bool) {
	if want == "" {
		return 0, false
	}
	bestRank := -1
	for _, st := range streams {
		if st.Type != typ {
			continue
		}
		lang := st.LangCode
		if lang == "" {
			lang = st.Language
		}
		if langCode(lang) != canonCode(want) {
			continue
		}
		if r := streamRank(st, wantForced); r > bestRank {
			bestRank, id = r, st.ID
		}
	}
	return id, bestRank == idealRank(wantForced)
}

// Track ranks, highest wins. rankWanted is whichever of forced/plain the caller
// asked for, so the same scale serves both directions.
const (
	rankForced     = 0 // covers foreign dialogue only, never a full translation
	rankImpaired   = 1 // complete, but written for an audience this user did not ask to join
	rankCommentary = 2 // the right language, an entirely different soundtrack
	rankPlain      = 3
	rankWanted     = 4
)

func idealRank(wantForced bool) int {
	if wantForced {
		return rankWanted
	}
	return rankPlain
}

// streamRank scores how well a track serves the request, ties keeping the first
// track, which is the file's own order.
//
// The container flag decides what a track is. The title is only consulted when
// the flag is unset, because a muxer that names a track "Forced" often leaves
// the flag out and Plex passes it through rather than inferring it.
func streamRank(st plex.EpisodeStream, wantForced bool) int {
	switch {
	case st.Forced || titleSaysForced(st.Title, wantForced):
		if wantForced {
			return rankWanted
		}
		return rankForced
	case st.VisualImpaired || st.HearingImpaired:
		return rankImpaired
	case isCommentary(st.Title):
		return rankCommentary
	}
	// A full track. What was asked for when forced was not, and the fallback
	// when it was: signs-only exists in some files and not in others.
	return rankPlain
}

// titleSaysForced is plex.ForcedTitle plus the markers that are only safe to
// read in one direction.
//
// ponytail: "signs" and "schilder" are the dominant labels for an unflagged
// signs-only track, but they are also plausible names for a full one - so they
// only count when forced is what we are looking for. In that direction a false
// positive costs nothing (we are already choosing among tracks of the wanted
// language, and forced is the goal); in the other it would demote the track the
// user actually asked for.
func titleSaysForced(title string, loose bool) bool {
	if plex.ForcedTitle(title) {
		return true
	}
	if !loose {
		return false
	}
	t := strings.ToLower(title)
	return strings.Contains(t, "signs") || strings.Contains(t, "schilder")
}

func isCommentary(title string) bool {
	t := strings.ToLower(title)
	return strings.Contains(t, "commentary") || strings.Contains(t, "kommentar")
}

// trackedEpisodes is the set of episodes a watch actually covers: every video
// the crawler has seen under its remote path, named the way the sync would file
// it, plus the ones the watch has already downloaded. Season-encoded via epKey.
//
// It exists because a Plex preference must not reach past the watch. The show's
// Plex listing is the whole show - for an endless series that is every episode
// ever aired, across seasons nobody asked to be touched.
//
// The set is keyed by episode NUMBER rather than by path on purpose: an episode
// the user fetched by hand sits in the same season under a name of his own, and
// the number is the only thing that ties it to the remote file it came from. The
// remote name goes through the watch's own rename first, so an endless series'
// absolute number is resolved to the same (season, episode) the sync would file
// it under.
//
// ponytail: downloads carries no watch_id, so that half is attributed by server
// plus remote prefix - and clearing the download history empties it. The
// remote_index half is what keeps the set standing.
func (s *Server) trackedEpisodes(w Watch) map[int]bool {
	eps := map[int]bool{}
	add := func(name string) {
		m := epSeasonRe.FindStringSubmatch(name)
		if m == nil {
			return
		}
		se, _ := strconv.Atoi(m[1])
		ep, _ := strconv.Atoi(m[2])
		eps[epKey(se, ep)] = true
	}
	// instr(x, p) = 1 rather than LIKE p||'/%': the path is user data and LIKE
	// would read a "_" in a folder name as a wildcard.
	nameFn := s.watchNameFn(w)
	rows, err := s.DB.Query(`SELECT name FROM remote_index
		WHERE server_id = ? AND is_dir = 0 AND (parent = ? OR instr(parent, ?) = 1)`,
		w.ServerID, w.RemotePath, w.RemotePath+"/")
	if err == nil {
		for rows.Next() {
			var name string
			if rows.Scan(&name) != nil || !videoExt[strings.ToLower(filepath.Ext(name))] {
				continue
			}
			if nameFn != nil {
				// the rename is what turns "1187" into S34E01 for an aired
				// mapping watch, exactly as the sync would file it
				if n := nameFn(name); n != "" {
					name = n
				}
			}
			add(name)
		}
		rows.Close()
	}
	// what is already on disk under this watch, including the episodes
	// processPendingEpisodes moved out of the collecting folder later
	drows, derr := s.DB.Query(`SELECT local_path FROM downloads
		WHERE status = 'done' AND server_id = ? AND (remote_path = ? OR instr(remote_path, ?) = 1)`,
		w.ServerID, w.RemotePath, w.RemotePath+"/")
	if derr == nil {
		for drows.Next() {
			var local string
			if drows.Scan(&local) != nil {
				continue
			}
			add(path.Base(local))
		}
		drows.Close()
	}
	return eps
}

// watchEpisodeParts locates the watch's show in Plex and returns its episode
// parts keyed by the LOCAL file path (Plex paths mapped through plex_roots).
func (s *Server) watchEpisodeParts(c *plex.Client, w Watch) (map[string]plex.EpisodePart, bool) {
	sh, _, _, ok := s.plexShowForWatch(w, match.GuessTitle(path.Base(w.RemotePath)))
	if !ok {
		return nil, false
	}
	parts, err := c.EpisodeParts(sh.RatingKey)
	if err != nil {
		return nil, false
	}
	byFile := make(map[string]plex.EpisodePart, len(parts))
	for _, p := range parts {
		byFile[s.mapPlexPath(p.File)] = p
	}
	return byFile, true
}

// planStreams turns the watch's preference into the two stream ids to send, and
// names what the file could not deliver ("", "audio", "sub", "audio,sub").
//
// A miss is not the same as a failure to apply: the dimension that WAS resolved
// is still set. It says the file does not (yet) hold what was asked for, which
// is the thing worth telling the user and the thing worth looking at again once
// a re-release has overwritten the file.
func planStreams(streams []plex.EpisodeStream, audioLang, subPref string) (audioID, subID int64, miss string) {
	audioID, subID = plex.StreamLeave, plex.StreamLeave
	addMiss := func(what string) {
		if miss != "" {
			miss += ","
		}
		miss += what
	}
	if audioLang != "" {
		// audio has no forced variant, so an exact miss here means the language
		// is only present as commentary or audio description
		if id, exact := pickStream(streams, 2, audioLang, false); id != 0 {
			audioID = id
			if !exact {
				addMiss("audio")
			}
		} else {
			addMiss("audio")
		}
	}
	switch code, forced, off := subChoice(subPref); {
	case off:
		subID = 0 // Plex reads 0 as "no subtitles"
	case code != "":
		if id, exact := pickStream(streams, 3, code, forced); id != 0 {
			subID = id
			if !exact {
				addMiss("sub") // the language is there, the variant is not
			}
		} else {
			addMiss("sub")
		}
	}
	return audioID, subID, miss
}

// applyStreams selects the preferred streams on one episode part. ok=false means
// Plex trouble and is worth another tick; miss names what the file lacks, which
// is worth another tick too - a dub re-release overwrites the same path and Plex
// re-analyses it later, so the tracks a file has can change under us.
//
// Leaf listings often omit streams (PMS ignores includeStreams there), so they
// are fetched per episode.
func applyStreams(c *plex.Client, p plex.EpisodePart, audioLang, subPref string) (miss string, ok bool) {
	streams := p.Streams
	if len(streams) == 0 {
		detail, err := c.PartStreams(p.RatingKey)
		if err != nil {
			return "", false
		}
		for _, dp := range detail {
			if dp.PartID == p.PartID {
				streams = dp.Streams
			}
		}
	}
	if len(streams) == 0 {
		return "", false // no part matched: Plex is mid-analysis, look again
	}
	audioID, subID, miss := planStreams(streams, audioLang, subPref)
	if audioID < 0 && subID < 0 {
		return miss, true // nothing resolved, nothing to send
	}
	return miss, c.SetStreams(p.PartID, audioID, subID) == nil
}

// processPlexStreamQueue drains plex_stream_queue from the sweep: finished
// downloads whose episode Plex has indexed get their streams selected; dead
// downloads and expired entries are dropped, everything else retries next tick.
func (s *Server) processPlexStreamQueue() {
	// the give-up clock hangs off the download's own timestamp, not off the
	// moment it was queued: updated_at moves while the transfer runs and stops
	// at completion, so a slow download can no longer expire before its first
	// attempt, and a retry window is measured from when the file actually landed.
	//
	// The queue timestamp still wins when it is the later of the two: a filed
	// pending episode is re-queued long after its download finished, and reading
	// only updated_at would expire that row before its first attempt.
	rows, err := s.DB.Query(`SELECT q.download_id, q.watch_id, MAX(IFNULL(d.updated_at, q.created_at), q.created_at), IFNULL(d.local_path, ''), IFNULL(d.status, '')
		FROM plex_stream_queue q LEFT JOIN downloads d ON d.id = q.download_id`)
	if err != nil {
		return
	}
	type item struct {
		downloadID int64
		localPath  string
		age        time.Duration
	}
	pending := map[int64][]item{} // watch id -> done downloads awaiting Plex
	var drop []int64
	for rows.Next() {
		var dlID, watchID int64
		var stamp, localPath, status string
		if rows.Scan(&dlID, &watchID, &stamp, &localPath, &status) != nil {
			continue
		}
		age := time.Duration(math.MaxInt64) // unparseable timestamp counts as expired
		if t, err := time.Parse(sqliteTime, stamp); err == nil {
			age = time.Since(t)
		}
		switch {
		case status == "" || status == "error" || status == "canceled":
			drop = append(drop, dlID) // download gone or dead: nothing to select
		case age > plexStreamGiveUp:
			slog.Warn("plex stream selection expired", "download", dlID, "watch", watchID)
			drop = append(drop, dlID)
		case status == "done":
			pending[watchID] = append(pending[watchID], item{dlID, localPath, age})
		}
		// queued/running/paused: not our turn yet
	}
	rows.Close()
	for _, id := range drop {
		s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, id)
	}
	if len(pending) == 0 {
		return
	}
	c := s.plexClient()
	if c == nil {
		return // Plex unconfigured: keep entries, the give-up window bounds them
	}
	for watchID, items := range pending {
		w, ok := s.loadWatch(watchID)
		if !ok {
			for _, it := range items { // watch deleted: queue is orphaned
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
			}
			continue
		}
		byFile, ok := s.watchEpisodeParts(c, w)
		if !ok {
			continue // show not (yet) in Plex, retry next tick
		}
		seen, verdict := false, ""
		nudge := map[string]bool{} // directories worth asking Plex to re-scan
		for _, it := range items {
			abs, err := s.safeLocal(it.localPath)
			if err != nil {
				slog.Warn("plex stream selection dropped", "download", it.downloadID,
					"watch", watchID, "reason", "local path outside the allowed roots")
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
				continue
			}
			p, found := byFile[abs]
			if !found {
				nudge[path.Dir(abs)] = true
				continue // not indexed yet, retry
			}
			miss, ok := applyStreams(c, p, w.PlexAudioLang, w.PlexSubLang)
			if !ok {
				continue // Plex trouble, retry next tick
			}
			seen = true
			if miss != "" && verdict == "" {
				verdict = miss
			}
			switch {
			case miss == "":
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
			case it.age > plexStreamMissGiveUp:
				// the file is what it is: stop looking, but keep the verdict on
				// the watch so it stays visible after the queue row is gone
				slog.Warn("plex stream language missing", "download", it.downloadID, "watch", watchID,
					"audio", w.PlexAudioLang, "sub", w.PlexSubLang, "miss", miss)
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
			default:
				nudge[path.Dir(abs)] = true // a re-release may have replaced it
			}
		}
		// One scan request per directory per drain, not per episode: the point
		// is to shorten the wait for Plex's own schedule, and it is best effort.
		// ponytail: no backoff, so a directory that stays missing is asked once
		// every sweep tick until the give-up window closes. An attempts column
		// on plex_stream_queue is the upgrade path if that ever shows up.
		for dir := range nudge {
			s.plexRescan(dir)
		}
		if seen {
			s.setPlexStreamMiss(watchID, verdict)
		}
	}
}

// setPlexStreamMiss records what the preference could not deliver, writing only
// on a change so the common case costs one read.
func (s *Server) setPlexStreamMiss(watchID int64, miss string) {
	var cur string
	if s.DB.QueryRow(`SELECT plex_stream_miss FROM watches WHERE id = ?`, watchID).Scan(&cur) != nil || cur == miss {
		return
	}
	s.DB.Exec(`UPDATE watches SET plex_stream_miss = ? WHERE id = ?`, miss, watchID)
}

// handleWatchPlexStreams applies the watch's Plex playback preference to the
// episodes it tracks and already has (retroactive pass).
//
//	@Summary		Apply Plex stream preference to existing episodes
//	@Description	Selects the watch's preferred audio/subtitle streams on the episodes this watch tracks and Plex already has. Runs in the background.
//	@Tags			Watches
//	@Produce		json
//	@Param			id	path	int	true	"Watch ID"
//	@Success		202	{object}	WatchCheckResponse
//	@Failure		400	{object}	ErrorResponse
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/watches/{id}/plex-streams [post]
func (s *Server) handleWatchPlexStreams(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	wt, ok := s.loadWatch(id)
	if !ok || wt.UserID != u.ID {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	if wt.PlexAudioLang == "" && wt.PlexSubLang == "" {
		writeErr(w, http.StatusBadRequest, "no Plex stream preference set")
		return
	}
	s.applyPlexStreamsJob(wt)
	writeJSON(w, http.StatusAccepted, WatchCheckResponse{Status: "applying"})
}

// applyPlexStreamsJob runs the retroactive pass in the background: the episodes
// this watch tracks get its preference. Fired from the button, from a preference
// change (the queue only ever covers downloads that come AFTER it), and once per
// install for the watches that predate the verdict column.
func (s *Server) applyPlexStreamsJob(wt Watch) {
	s.runJob(fmt.Sprintf("plex:streams:%d", wt.ID), func(context.Context) {
		c := s.plexClient()
		if c == nil {
			return
		}
		// the watch's own episodes, not every episode Plex has under the folder:
		// an endless series' show listing spans a thousand episodes across
		// seasons the watch never asked for
		abs := s.watchTarget(wt)
		tracked := s.trackedEpisodes(wt)
		if len(tracked) == 0 {
			slog.Warn("plex stream preference skipped", "watch", wt.ID,
				"reason", "the watch tracks no episode yet - nothing crawled, nothing downloaded",
				"local", logSafe(abs))
			return
		}
		byFile, ok := s.watchEpisodeParts(c, wt)
		if !ok {
			// the show could not be resolved at all, or Plex refused the episode
			// listing - either way nothing is selected. The local target is what
			// tells the two apart, so log it beside the source folder.
			showKey, _, _ := s.folderUnit(wt.ServerID, wt.RemotePath)
			slog.Warn("plex show not resolved", "watch", wt.ID,
				"remote", logSafe(wt.RemotePath), "local", logSafe(abs), "showKey", logSafe(showKey))
			return
		}
		applied, missed, verdict, seen := 0, 0, "", false
		for file, p := range byFile {
			if file != abs && !strings.HasPrefix(file, abs+"/") {
				continue
			}
			m := epSeasonRe.FindStringSubmatch(path.Base(file))
			if m == nil {
				continue // no episode number: not something the watch can claim
			}
			se, _ := strconv.Atoi(m[1])
			ep, _ := strconv.Atoi(m[2])
			if !tracked[epKey(se, ep)] {
				continue
			}
			miss, ok := applyStreams(c, p, wt.PlexAudioLang, wt.PlexSubLang)
			if !ok {
				continue
			}
			seen = true
			if miss == "" {
				applied++
				continue
			}
			missed++
			if verdict == "" {
				verdict = miss
			}
		}
		if seen {
			s.setPlexStreamMiss(wt.ID, verdict)
		}
		// applied counts episodes that got everything asked for. The old count
		// included episodes where nothing was selected at all, which made the
		// line read like proof that the preference had worked.
		slog.Info("plex stream preference applied", "watch", wt.ID, "episodes", applied, "missing", missed)
	})
}
