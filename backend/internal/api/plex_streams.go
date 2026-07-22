package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path"
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

// pickStream returns the id of the first stream of typ (2 audio, 3 subtitle)
// matching the wanted app language code ("Ger", "Jap"); 0 = no preference or
// not present in this file.
func pickStream(streams []plex.EpisodeStream, typ int, want string) int64 {
	if want == "" {
		return 0
	}
	for _, st := range streams {
		if st.Type != typ {
			continue
		}
		lang := st.LangCode
		if lang == "" {
			lang = st.Language
		}
		if langCode(lang) == canonCode(want) {
			return st.ID
		}
	}
	return 0
}

// watchEpisodeParts locates the watch's show in Plex and returns its episode
// parts keyed by the LOCAL file path (Plex paths mapped through plex_roots).
func (s *Server) watchEpisodeParts(c *plex.Client, w Watch) (map[string]plex.EpisodePart, bool) {
	local := w.LocalPath
	if w.Subfolder {
		local = path.Join(w.LocalPath, path.Base(w.RemotePath))
	}
	sh, _, ok := s.plexShowFor(match.GuessTitle(path.Base(w.RemotePath)), local)
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

// applyStreams selects the preferred streams on one episode part. done=false
// only on a Plex error (retry); a missing wanted language is final - the file
// is what it is, waiting will not grow it a track. Leaf listings often omit
// streams (PMS ignores includeStreams there), so they are fetched per episode.
func applyStreams(c *plex.Client, p plex.EpisodePart, audioLang, subLang string) (done bool) {
	streams := p.Streams
	if len(streams) == 0 {
		detail, err := c.PartStreams(p.RatingKey)
		if err != nil {
			return false
		}
		for _, dp := range detail {
			if dp.PartID == p.PartID {
				streams = dp.Streams
			}
		}
	}
	audioID := pickStream(streams, 2, audioLang)
	subID := pickStream(streams, 3, subLang)
	if audioID == 0 && subID == 0 {
		return true
	}
	return c.SetStreams(p.PartID, audioID, subID) == nil
}

// processPlexStreamQueue drains plex_stream_queue from the sweep: finished
// downloads whose episode Plex has indexed get their streams selected; dead
// downloads and expired entries are dropped, everything else retries next tick.
func (s *Server) processPlexStreamQueue() {
	rows, err := s.DB.Query(`SELECT q.download_id, q.watch_id, q.created_at, IFNULL(d.local_path, ''), IFNULL(d.status, '')
		FROM plex_stream_queue q LEFT JOIN downloads d ON d.id = q.download_id`)
	if err != nil {
		return
	}
	type item struct {
		downloadID int64
		localPath  string
	}
	pending := map[int64][]item{} // watch id -> done downloads awaiting Plex
	var drop []int64
	for rows.Next() {
		var dlID, watchID int64
		var createdAt, localPath, status string
		if rows.Scan(&dlID, &watchID, &createdAt, &localPath, &status) != nil {
			continue
		}
		expired := true // unparseable timestamp counts as expired
		if t, err := time.Parse(sqliteTime, createdAt); err == nil {
			expired = time.Since(t) > plexStreamGiveUp
		}
		switch {
		case status == "" || status == "error" || status == "canceled":
			drop = append(drop, dlID) // download gone or dead: nothing to select
		case expired:
			slog.Warn("plex stream selection expired", "download", dlID, "watch", watchID)
			drop = append(drop, dlID)
		case status == "done":
			pending[watchID] = append(pending[watchID], item{dlID, localPath})
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
		var w Watch
		if s.DB.QueryRow(`SELECT id, server_id, remote_path, local_path, subfolder, plex_audio_lang, plex_sub_lang FROM watches WHERE id = ?`, watchID).
			Scan(&w.ID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Subfolder, &w.PlexAudioLang, &w.PlexSubLang) != nil {
			for _, it := range items { // watch deleted: queue is orphaned
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
			}
			continue
		}
		byFile, ok := s.watchEpisodeParts(c, w)
		if !ok {
			continue // show not (yet) in Plex, retry next tick
		}
		for _, it := range items {
			abs, err := s.safeLocal(it.localPath)
			if err != nil {
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
				continue
			}
			p, found := byFile[abs]
			if !found {
				continue // not indexed yet, retry
			}
			if applyStreams(c, p, w.PlexAudioLang, w.PlexSubLang) {
				s.DB.Exec(`DELETE FROM plex_stream_queue WHERE download_id = ?`, it.downloadID)
			}
		}
	}
}

// handleWatchPlexStreams applies the watch's Plex playback preference to every
// episode of the show already in the library (retroactive pass).
//
//	@Summary		Apply Plex stream preference to existing episodes
//	@Description	Selects the watch's preferred audio/subtitle streams on every episode of the show Plex already has. Runs in the background.
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
	var wt Watch
	if s.DB.QueryRow(`SELECT id, server_id, remote_path, local_path, subfolder, plex_audio_lang, plex_sub_lang FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).
		Scan(&wt.ID, &wt.ServerID, &wt.RemotePath, &wt.LocalPath, &wt.Subfolder, &wt.PlexAudioLang, &wt.PlexSubLang) != nil {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	if wt.PlexAudioLang == "" && wt.PlexSubLang == "" {
		writeErr(w, http.StatusBadRequest, "no Plex stream preference set")
		return
	}
	s.runJob(fmt.Sprintf("plex:streams:%d", id), func(context.Context) {
		c := s.plexClient()
		if c == nil {
			return
		}
		byFile, ok := s.watchEpisodeParts(c, wt)
		if !ok {
			slog.Warn("plex stream apply: show not found in Plex", "watch", wt.ID, "remote", wt.RemotePath)
			return
		}
		// every episode under the watch's local folder, not just synced ones
		local := wt.LocalPath
		if wt.Subfolder {
			local = path.Join(wt.LocalPath, path.Base(wt.RemotePath))
		}
		abs, err := s.safeLocal(local)
		if err != nil {
			return
		}
		n := 0
		for file, p := range byFile {
			if file != abs && !strings.HasPrefix(file, abs+"/") {
				continue
			}
			if applyStreams(c, p, wt.PlexAudioLang, wt.PlexSubLang) {
				n++
			}
		}
		slog.Info("plex stream preference applied", "watch", wt.ID, "episodes", n)
	})
	writeJSON(w, http.StatusAccepted, WatchCheckResponse{Status: "applying"})
}
