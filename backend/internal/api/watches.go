package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
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
	Subfolder     bool   `json:"subfolder"`   // write into local_path/<remote name> instead of local_path directly
	MediaID       int    `json:"mediaId"`     // linked AniList/TMDB id → metadata (cover, episodes, airing); 0 = auto/none
	MediaSource   string `json:"mediaSource"` // metadata provider for a manual link: "anilist" | "tmdb:tv" | "tmdb:movie"
	FromEpisode   int    `json:"fromEpisode"` // count only local episodes >= this (shared season folder); 0 = all
	WantDub       string `json:"wantDub"`     // sync only files tagged with this dub language code (e.g. "Ger"); "" = any
	WantSub       string `json:"wantSub"`     // sync only files tagged with this sub language code; "" = any
	IntervalMin   int    `json:"intervalMin"` // global setting, echoed for the UI
	LastCheck     string `json:"lastCheck"`
	LastResult    string `json:"lastResult"`    // error text of the last check, "" on success
	LastQueued    int    `json:"lastQueued"`    // files queued at the last check, -1 = none yet
	LastUploading int    `json:"lastUploading"` // files still uploading remotely at the last check
	LangWaiting   int    `json:"langWaiting"`   // videos on the remote skipped by the dub/sub filter, target not yet local
	CreatedAt     string `json:"createdAt"`

	// enriched for the overview
	Media          *anilist.Media `json:"media,omitempty"`
	LocalFiles     int            `json:"localFiles"`
	Active         int            `json:"active"`                   // queued/running downloads for this watch
	Complete       bool           `json:"complete"`                 // finished title, all episodes synced
	NextEpisode    int            `json:"nextEpisode,omitempty"`    // upcoming episode number (offset-adjusted, local numbering)
	NextEpisodeAbs int            `json:"nextEpisodeAbs,omitempty"` // absolute AniList number, shown in parens when it differs
	SeenEpisodes   int            `json:"seenEpisodes,omitempty"`   // watched episodes from the linked AniList list
	NextAiringAt   int64          `json:"nextAiringAt,omitempty"`   // unix seconds of its release
	Waiting        bool           `json:"waiting"`                  // smart sync: idle until NextAiringAt
	Behind         int            `json:"behind,omitempty"`         // episodes aired per AniList but not yet available locally (the source release can lag the original broadcast)
	Missing        []int          `json:"missing,omitempty"`        // gaps below the newest local episode (e.g. have 1,2,3,5 → 4 is missing), independent of airing state
	Offset         int            `json:"offset,omitempty"`         // {episode-N} renumber offset: absolute episode = local - offset (for showing the original number)
	Airings        []Airing       `json:"airings,omitempty"`        // every scheduled future release the provider knows (multi-week calendar)
	Category       string         `json:"category,omitempty"`       // anime-series | anime-movie | series | movie (calendar filter)
}

// Airing is one upcoming episode slot for the calendar, in the watch's local
// numbering (offset applied); EpisodeAbs carries the original number when it differs.
type Airing struct {
	At         int64 `json:"at"`
	Episode    int   `json:"episode"`
	EpisodeAbs int   `json:"episodeAbs,omitempty"`
}

// WatchCreateResponse carries the id of a newly created watch.
type WatchCreateResponse struct {
	ID int64 `json:"id"`
}

// WatchCheckResponse acknowledges a queued manual watch check.
type WatchCheckResponse struct {
	Status string `json:"status" example:"checking"`
}

// watchCategory buckets a watch for the calendar's Animeserie/Animefilm/Serie/Film
// split, from the metadata provider plus the AniList format.
func watchCategory(source string, m *anilist.Media) string {
	switch {
	case source == "tmdb:movie":
		return "movie"
	case source == "tmdb:tv":
		return "series"
	case m != nil && m.Format == "MOVIE":
		return "anime-movie"
	default:
		return "anime-series" // anilist / unset
	}
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
			rows, err := s.DB.Query(`SELECT id, server_id, remote_path, local_path, subfolder, template, from_episode, last_check FROM watches`)
			if err != nil {
				continue
			}
			type cand struct {
				id                                         int64
				serverID                                   int64
				remotePath, localPath, template, lastCheck string
				subfolder                                  bool
				fromEpisode                                int
			}
			var cands []cand
			for rows.Next() {
				var c cand
				rows.Scan(&c.id, &c.serverID, &c.remotePath, &c.localPath, &c.subfolder, &c.template, &c.fromEpisode, &c.lastCheck)
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
				local := c.localPath
				if c.subfolder {
					local = path.Join(c.localPath, path.Base(c.remotePath))
				}
				have := s.countVideos(local, c.fromEpisode)
				if smartDue(intervalDue, media, have, watchOffset(c.template), c.fromEpisode, now) {
					s.runWatch(c.id)
				}
			}
		}
	}
}

// offsetRe extracts the numeric offset from a rename template's {episode±N}
// placeholder, mapping absolute (broadcast) episode numbers to the local
// season-relative ones. e.g. "{episode-1155:02}" → -1155.
var offsetRe = regexp.MustCompile(`\{episode([+-]\d+)`)

func watchOffset(template string) int {
	m := offsetRe.FindStringSubmatch(template)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// smartDue decides whether a watch should check now. Without an AniList
// airing schedule the plain interval rule applies. With one, a watch that
// already holds every aired episode stays idle until the next episode's
// release time. offset maps AniList's absolute episode numbers to the local
// season-relative ones (rename template); fromEpisode is the part's first
// local episode when it shares a season folder. haveEps is the count of the
// part's local files, compared against how many of its episodes have aired.
func smartDue(intervalDue bool, media *anilist.Media, haveEps, offset, fromEpisode int, now time.Time) bool {
	if !intervalDue {
		return false
	}
	if media == nil || media.NextAiring == nil {
		return true
	}
	start := fromEpisode
	if start < 1 {
		start = 1
	}
	airedInPart := media.NextAiring.Episode + offset - start // aired episodes belonging to this part
	if haveEps >= airedInPart && now.Unix() < media.NextAiring.AiringAt {
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
	err := s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, want_dub, want_sub
		FROM watches WHERE id = ?`, id).
		Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator, &w.TitleOverride, &w.Pattern, &w.Replacement, &w.Subfolder, &w.WantDub, &w.WantSub)
	if err != nil {
		return
	}
	s.DB.Exec(`UPDATE watches SET last_check = datetime('now') WHERE id = ?`, id)

	ids, uploading, filtered, err := s.Transfers.Enqueue(w.UserID, w.ServerID, w.RemotePath, w.LocalPath, watchNameFn(w), watchLangFilter(w), true, !w.Subfolder)
	// structured result: the frontend localizes the counts; last_result only
	// carries the error text of a failed check
	result, queued := "", len(ids)
	if err != nil {
		result, queued, uploading, filtered = err.Error(), -1, 0, 0
		slog.Warn("watch check", "id", id, "err", err)
	}
	s.DB.Exec(`UPDATE watches SET last_result = ?, last_queued = ?, last_uploading = ?, last_filtered = ? WHERE id = ?`, result, queued, uploading, filtered, id)
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

// watchLangFilter returns a predicate that keeps only remote files whose
// name/folder carries the wanted dub/sub language tag, or nil when the watch
// has no language preference. The full remote path is matched so a
// folder-level tag ("Show [GerDub]/ep01.mkv") applies to every file inside.
func watchLangFilter(w Watch) func(string) bool {
	if w.WantDub == "" && w.WantSub == "" {
		return nil
	}
	return func(remotePath string) bool {
		return rename.LangMatch(remotePath, w.WantDub, w.WantSub)
	}
}

// handleWatchesList returns the caller's watches enriched with metadata,
// local file counts, airing schedule and completeness state.
//
// @Summary      List watches
// @Description  Returns the authenticated user's watches, each enriched with linked media metadata, local episode counts, airing schedule, missing-episode gaps and completeness state.
// @Tags         Watches
// @Produce      json
// @Success      200  {array}   Watch
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches [get]
func (s *Server) handleWatchesList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	interval := s.watchInterval()
	rows, err := s.DB.Query(`SELECT w.id, w.user_id, w.server_id, s.name, w.remote_path, w.local_path,
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.subfolder, w.from_episode, w.want_dub, w.want_sub, w.last_check, w.last_result, w.last_queued, w.last_uploading, w.last_filtered, w.created_at
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
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement, &it.Subfolder, &it.FromEpisode, &it.WantDub, &it.WantSub,
			&it.LastCheck, &it.LastResult, &it.LastQueued, &it.LastUploading, &it.LangWaiting, &it.CreatedAt); err != nil {
			dbErr(w)
			return
		}
		it.IntervalMin = interval
		it.Media = s.watchMedia(it.ServerID, it.RemotePath)
		local := it.LocalPath
		if it.Subfolder {
			local = path.Join(it.LocalPath, path.Base(it.RemotePath))
		}
		it.LocalFiles = s.countVideos(local, it.FromEpisode)
		it.Missing = missingEpisodes(s.localEpisodeNums(local, it.FromEpisode))
		s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ?
			AND status IN ('queued','running','paused') AND remote_path LIKE ? || '%'`,
			u.ID, it.ServerID, it.RemotePath).Scan(&it.Active)
		offset := watchOffset(it.Template)
		it.Offset = offset
		// LocalFiles is already scoped to this part (from_episode), so it
		// compares directly against the linked entry's episode count.
		it.Complete = it.Media != nil && it.Media.Status == "FINISHED" && it.Media.Episodes > 0 &&
			it.LocalFiles >= it.Media.Episodes && it.Active == 0
		if it.Media != nil {
			it.MediaID = it.Media.ID
			it.SeenEpisodes = progress[it.Media.ID]
			// surface the match source so the edit dialog prefills the right
			// provider and the UI can drop anime-only cosmetics (JST) for TMDB
			s.DB.QueryRow(`SELECT source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
				it.ServerID, it.RemotePath).Scan(&it.MediaSource)
		}
		if it.Media != nil && it.Media.NextAiring != nil {
			it.NextEpisode = it.Media.NextAiring.Episode + offset
			if offset != 0 {
				it.NextEpisodeAbs = it.Media.NextAiring.Episode // show absolute in parens
			}
			it.NextAiringAt = it.Media.NextAiring.AiringAt
			it.Waiting = !smartDue(true, it.Media, it.LocalFiles, offset, it.FromEpisode, time.Now())
			// aired per AniList but not yet local - the source release can lag
			// the original broadcast; auto-sync keeps checking and grabs them
			start := it.FromEpisode
			if start < 1 {
				start = 1
			}
			if aired := it.Media.NextAiring.Episode + offset - start; aired > it.LocalFiles {
				it.Behind = aired - it.LocalFiles
			}
		}
		if it.Media != nil {
			it.Category = watchCategory(it.MediaSource, it.Media)
			now := time.Now().Unix()
			start := it.FromEpisode
			for _, a := range it.Media.FutureAirings() {
				if a.AiringAt <= now || a.Episode+offset < start {
					continue // already aired, or belongs to an earlier part of a shared folder
				}
				air := Airing{At: a.AiringAt, Episode: a.Episode + offset}
				if offset != 0 {
					air.EpisodeAbs = a.Episode
				}
				it.Airings = append(it.Airings, air)
			}
		}
		list = append(list, it)
	}
	writeJSON(w, http.StatusOK, list)
}

var epNumRe = regexp.MustCompile(`(?i)S\d+E(\d+)`)

// countVideos counts local video files. When minEp > 0, only files whose
// SxxEyy episode number is >= minEp count - for watches that share a season
// folder with earlier parts (e.g. Dr. Stone S4 Part 3 starts at E26, Conan
// S33 at E31), so only this part's episodes are tallied.
func (s *Server) countVideos(rel string, minEp int) int {
	abs, err := s.safeLocal(rel)
	if err != nil {
		return 0
	}
	n := 0
	filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		if minEp > 0 {
			m := epNumRe.FindStringSubmatch(d.Name())
			if m == nil {
				return nil
			}
			if ep, _ := strconv.Atoi(m[1]); ep < minEp {
				return nil
			}
		}
		n++
		return nil
	})
	return n
}

// localEpisodeNums returns the set of SxxEyy episode numbers present locally
// (only files >= minEp when minEp > 0). Used for gap detection - files without a
// parseable episode number are ignored.
func (s *Server) localEpisodeNums(rel string, minEp int) map[int]bool {
	abs, err := s.safeLocal(rel)
	if err != nil {
		return nil
	}
	nums := map[int]bool{}
	filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		m := epNumRe.FindStringSubmatch(d.Name())
		if m == nil {
			return nil
		}
		ep, _ := strconv.Atoi(m[1])
		if ep >= minEp {
			nums[ep] = true
		}
		return nil
	})
	return nums
}

// missingEpisodes returns the gaps WITHIN the contiguous span of local episodes,
// i.e. between the lowest and highest number present (e.g. {1,2,3,5} → [4]).
// Only holes inside what you already have count - episodes before the first or
// after the last are a partial start / a Behind tail, not gaps.
func missingEpisodes(nums map[int]bool) []int {
	if len(nums) < 2 {
		return nil
	}
	lo, hi := 1<<31, 0
	for e := range nums {
		if e < lo {
			lo = e
		}
		if e > hi {
			hi = e
		}
	}
	var missing []int
	for e := lo + 1; e < hi; e++ {
		if !nums[e] {
			missing = append(missing, e)
		}
	}
	return missing
}

// handleWatchCreate registers a new watch and triggers a first sync.
//
// @Summary      Create watch
// @Description  Registers a new persistent watch on a remote folder, optionally linking media metadata, and kicks off a first sync immediately.
// @Tags         Watches
// @Accept       json
// @Produce      json
// @Param        body  body  Watch  true  "Watch definition (serverId and remotePath required)"
// @Success      201  {object}  WatchCreateResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches [post]
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
	res, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, from_episode, want_dub, want_sub)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.ServerID, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.WantDub, in.WantSub)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	id, _ := res.LastInsertId()
	s.linkMedia(in.ServerID, in.RemotePath, in.MediaID, in.MediaSource)
	go s.runWatch(id) // first sync right away
	writeJSON(w, http.StatusCreated, WatchCreateResponse{ID: id})
}

// handleWatchUpdate edits an existing watch; a path change re-checks the folder.
//
// @Summary      Update watch
// @Description  Updates an existing watch's paths, rename rule, media link and language filters. Changing the remote or local path triggers an immediate re-check.
// @Tags         Watches
// @Accept       json
// @Produce      json
// @Param        id    path  int     true  "Watch ID"
// @Param        body  body  object  true  "Watch fields to update (remotePath required)"
// @Success      200  {object}  OkResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches/{id} [put]
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
		Subfolder     bool   `json:"subfolder"`
		MediaID       int    `json:"mediaId"`
		MediaSource   string `json:"mediaSource"`
		FromEpisode   int    `json:"fromEpisode"`
		WantDub       string `json:"wantDub"`
		WantSub       string `json:"wantSub"`
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
	var serverID int64
	if err := s.DB.QueryRow(`SELECT server_id, remote_path, local_path FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).
		Scan(&serverID, &oldRemote, &oldLocal); err != nil {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	_, err := s.DB.Exec(`UPDATE watches SET remote_path = ?, local_path = ?, mode = ?, template = ?, separator = ?, title_override = ?, pattern = ?, replacement = ?, subfolder = ?, from_episode = ?, want_dub = ?, want_sub = ?
		WHERE id = ? AND user_id = ?`, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.WantDub, in.WantSub, id, u.ID)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	s.linkMedia(serverID, in.RemotePath, in.MediaID, in.MediaSource)
	if in.RemotePath != oldRemote || in.LocalPath != oldLocal {
		go s.runWatch(id) // paths changed: check the new folder right away
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// linkMedia records a manual folder→media match so the overview shows real
// metadata (cover, episodes, airing) for a watch whose folder the catalog
// couldn't auto-match (e.g. an arc subfolder). id 0 leaves any match as-is.
// source is the metadata provider: "anilist" (anime) or "tmdb:tv"/"tmdb:movie"
// (live action); anything else falls back to anilist.
func (s *Server) linkMedia(serverID int64, folder string, mediaID int, source string) {
	if mediaID <= 0 {
		return
	}
	if source != "tmdb:tv" && source != "tmdb:movie" {
		source = "anilist"
	}
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, manual, source)
		VALUES (?, ?, ?, 1, ?)
		ON CONFLICT(server_id, folder) DO UPDATE SET media_id = excluded.media_id, manual = 1, source = excluded.source`,
		serverID, folder, mediaID, source)
}

// handleWatchDelete removes one of the caller's watches.
//
// @Summary      Delete watch
// @Description  Deletes one of the authenticated user's watches.
// @Tags         Watches
// @Produce      json
// @Param        id  path  int  true  "Watch ID"
// @Success      200  {object}  OkResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches/{id} [delete]
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
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleWatchCheck triggers a manual check; last_check is stamped inside
// runWatch, so the 30min countdown restarts from now.
//
// @Summary      Trigger watch check
// @Description  Queues an immediate check of one watch and resets its countdown. Reachable with a session cookie (own watches only) or a machine API token (any watch).
// @Tags         Watches
// @Produce      json
// @Param        id  path  int  true  "Watch ID"
// @Success      202  {object}  WatchCheckResponse
// @Failure      404  {object}  ErrorResponse
// @Security     CookieAuth
// @Security     BearerAuth
// @Router       /api/watches/{id}/check [post]
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
	writeJSON(w, http.StatusAccepted, WatchCheckResponse{Status: "checking"})
}
