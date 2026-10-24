package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/airmap"
	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/logbus"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/relname"
	"github.com/ch4d1/weebsync/internal/rename"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// Watch is a persistent remote-folder subscription: the folder is re-checked
// on an interval and new/changed files are downloaded automatically,
// optionally renamed via template.
type Watch struct {
	ID              int64  `json:"id"`
	UserID          int64  `json:"userId"`
	ServerID        int64  `json:"serverId"`
	ServerName      string `json:"serverName"`
	RemotePath      string `json:"remotePath"`
	LocalPath       string `json:"localPath"`
	Mode            string `json:"mode"` // "template" | "regex"
	Template        string `json:"template"`
	Separator       string `json:"separator"`
	TitleOverride   string `json:"titleOverride"`
	Pattern         string `json:"pattern"`
	Replacement     string `json:"replacement"`
	Subfolder       bool   `json:"subfolder"`       // write into local_path/<remote name> instead of local_path directly
	MediaID         int    `json:"mediaId"`         // linked AniList/TMDB id → metadata (cover, episodes, airing); 0 = auto/none
	MediaSource     string `json:"mediaSource"`     // metadata provider for a manual link: "anilist" | "tmdb:tv" | "tmdb:movie"
	FromEpisode     int    `json:"fromEpisode"`     // count only local episodes >= this (shared season folder); 0 = all
	AiredMapping    bool   `json:"airedMapping"`    // resolve absolute episode numbers to aired-order S/E via TVDB/TMDB (endless series)
	RenameProvider  string `json:"renameProvider"`  // tvdb | tmdb | "" (auto from Plex/default)
	RenameOrdering  string `json:"renameOrdering"`  // official | dvd | absolute | aired | "" (auto)
	RenameTitleLang string `json:"renameTitleLang"` // BCP-47 for the localized rename title; "" = Plex/system language
	RenameSeriesID  int    `json:"renameSeriesId"`  // explicit provider series id for rename; 0 = auto
	WantDub         string `json:"wantDub"`         // sync only files tagged with this dub language code (e.g. "Ger"); "" = any
	WantSub         string `json:"wantSub"`         // sync only files tagged with this sub language code; "" = any
	DubLagDays      int    `json:"dubLagDays"`      // days the WantDub release trails the original when no release has shown the lag yet; 0 = observed only
	PlexAudioLang   string `json:"plexAudioLang"`   // after sync, select this audio language in Plex; "" = don't touch
	PlexSubLang     string `json:"plexSubLang"`     // after sync, select subtitles in Plex: "" = don't touch, "off" = none, "Ger" = full, "Ger:forced" = forced
	// PlexStreamMiss: what the preference could not deliver on this watch's
	// files, a CSV of "audio" and "sub"; "" = everything asked for was there.
	PlexStreamMiss string `json:"plexStreamMiss,omitempty"`
	// ReplaceOld is read by the one-off sync only (an upgrade): the copy an
	// episode improves on is moved to the trash once the new file is in place.
	// Not stored on a watch - a watch with a rename rule already overwrites
	// re-releases by name.
	ReplaceOld  bool   `json:"replaceOld,omitempty"`
	IntervalMin int    `json:"intervalMin"` // global setting, echoed for the UI
	LastCheck   string `json:"lastCheck"`
	NextCheck   int64  `json:"nextCheck"`  // unix seconds of the next scheduled check, mirroring WatchLoop's due rule
	LastResult  string `json:"lastResult"` // error text of the last check, "" on success
	// CheckAttempts counts consecutive failed checks; > 0 means the watch is
	// on the short retry backoff and NextCheck is that retry, not the interval.
	CheckAttempts int    `json:"checkAttempts,omitempty"`
	LastQueued    int    `json:"lastQueued"`    // files queued at the last check, -1 = none yet
	LastUploading int    `json:"lastUploading"` // files still uploading remotely at the last check
	LangWaiting   int    `json:"langWaiting"`   // videos on the remote skipped by the dub/sub filter, target not yet local
	LastOwned     int    `json:"lastOwned"`     // files skipped at the last check because the library holds the episode under another name
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
	Unsorted       int            `json:"unsorted,omitempty"`       // episodes waiting in the collecting folder for the provider to list their number
	Missing        []EpRef        `json:"missing,omitempty"`        // gaps below the newest local episode (e.g. have 1,2,3,5 → 4 is missing), independent of airing state
	Seasons        []int          `json:"seasons,omitempty"`        // seasons the local folder holds (specials left out), ascending
	Offset         int            `json:"offset,omitempty"`         // {episode-N} renumber offset: absolute episode = local - offset (for showing the original number)
	Airings        []Airing       `json:"airings,omitempty"`        // every scheduled future release the provider knows (multi-week calendar)
	// Category is the calendar filter.
	Category string `json:"category,omitempty" enums:"anime-series,anime-movie,series,movie,manga"`
	// DubWaiting: the watch is caught up on the dub it filters for; the
	// original is ahead but the dub is not due yet - expected waiting, not
	// something to look at.
	DubWaiting     bool  `json:"dubWaiting,omitempty"`
	DubExpectedAt  int64 `json:"dubExpectedAt,omitempty"`  // forecast unix seconds of the next dub release; 0 = no date known
	DubOverdue     bool  `json:"dubOverdue,omitempty"`     // the forecast plus a week of grace passed without a release
	DubNextEpisode int   `json:"dubNextEpisode,omitempty"` // the episode the filtered dub is waited for, local numbering
	// LangWaitingEps: which episodes the dub/sub filter held back at the
	// last check (LangWaiting is their count); empty when the names carry
	// no SxxEyy.
	LangWaitingEps []EpRef `json:"langWaitingEps,omitempty"`
	// BehindLate: Behind holds more episodes than the last behindGrace of
	// releases explains - the source is not just a few hours behind.
	BehindLate bool `json:"behindLate,omitempty"`
	// DubProgress: a dub the older files carry and the newer ones lack, read
	// from the names or the releases they came from; nil when there is none.
	DubProgress *DubProgress `json:"dubProgress,omitempty"`
	// Attention: why this watch needs a hand, ordered by severity; empty =
	// fine. The one needs-attention source - dashboard, tile and the machine
	// status all read this, never their own arithmetic.
	Attention []string `json:"attention,omitempty"`
}

// Airing is one upcoming episode slot for the calendar, in the watch's local
// numbering (offset applied); EpisodeAbs carries the original number when it differs.
type Airing struct {
	At         int64  `json:"at"`      // unix seconds
	Episode    int    `json:"episode"` // local numbering (offset applied)
	EpisodeAbs int    `json:"episodeAbs,omitempty"`
	Dub        string `json:"dub,omitempty"`  // the dub this slot releases, short tag (de, en); "" = the original
	Est        bool   `json:"est,omitempty"`  // projected from the original plus the lag, not a date anyone published
	Have       bool   `json:"have,omitempty"` // the episode is in the local folder already
	// RemoteAt: when the episode's file reached the server - the first check
	// that queued it - or, before it has, when it should, from the slot plus
	// the upload lag learned on this watch (RemoteEst). Only on the slots of
	// the track the watch fetches; 0 when nothing is known yet.
	RemoteAt  int64 `json:"remoteAt,omitempty"`
	RemoteEst bool  `json:"remoteEst,omitempty"`
}

// WatchCreateResponse carries the id of a newly created watch.
type WatchCreateResponse struct {
	ID int64 `json:"id"`
}

// WatchCheckResponse acknowledges a queued manual watch check.
type WatchCheckResponse struct {
	Status string `json:"status" enums:"checking,checked" example:"checking"`
	// with wait=1: what the check did. Queued are the new download ids, so
	// the caller can follow them; Error is a failed check's reason
	Queued    []int64 `json:"queued,omitempty"`
	Uploading int     `json:"uploading,omitempty"`
	Filtered  int     `json:"filtered,omitempty"`
	Owned     int     `json:"owned,omitempty"`
	Error     string  `json:"error,omitempty"`
}

// watchCategory buckets a watch for the calendar's Animeserie/Animefilm/Serie/Film
// split, from the metadata provider plus the AniList format. TVDB catalogues
// both: a show the anime mapping files under its TVDB id is anime, anything
// else from there live action.
func watchCategory(source string, m *anilist.Media, tvdbAnime bool) string {
	switch {
	case source == mangaSource:
		return "manga" // light novels too: same shelf, same reader
	case source == "tmdb:movie", source == tvdbMovieSource && !tvdbAnime:
		return "movie"
	case source == "tmdb:tv", source == "tvdb" && !tvdbAnime:
		return "series"
	case m != nil && m.Format == "MOVIE":
		return "anime-movie"
	default:
		return "anime-series" // anilist / unset
	}
}

// tvdbAnime reports whether a TVDB match is a show the anime mapping knows.
func (s *Server) tvdbAnime(source string, id int) bool {
	if id == 0 {
		return false
	}
	if source == tvdbMovieSource {
		// the anime mapping knows no TVDB film: the genre alone tells
		m := s.cachedMedia(source, id)
		return m != nil && slices.Contains(m.Genres, "Anime")
	}
	if source != "tvdb" {
		return false
	}
	var n int
	// no row (or no read) means the mapping does not know it: the TVDB genre decides below
	_ = s.DB.QueryRow(`SELECT 1 FROM anime_ids WHERE tvdb_id = ? LIMIT 1`, id).Scan(&n)
	if n == 1 {
		return true
	}
	// a show the mapping does not know yet: TVDB's own genre
	m := s.cachedMedia(source, id)
	return m != nil && slices.Contains(m.Genres, "Anime")
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

// watchCandidate is one watch as the loop's tick judges whether it is due.
type watchCandidate struct {
	id                                         int64
	serverID                                   int64
	remotePath, localPath, template, lastCheck string
	subfolder                                  bool
	fromEpisode                                int
	aired                                      bool
	filtered                                   int
	retryAt                                    int64
}

// watchCandidates reads every watch for the loop. A half-read list is an
// error, not a shorter list: the watches it dropped would just wait a tick.
func (s *Server) watchCandidates() ([]watchCandidate, error) {
	rows, err := s.DB.Query(`SELECT id, server_id, remote_path, local_path, subfolder, template, from_episode, aired_mapping, last_filtered, last_check, retry_at FROM watches`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cands []watchCandidate
	for rows.Next() {
		var c watchCandidate
		if err := rows.Scan(&c.id, &c.serverID, &c.remotePath, &c.localPath, &c.subfolder, &c.template, &c.fromEpisode, &c.aired, &c.filtered, &c.lastCheck, &c.retryAt); err != nil {
			return nil, err
		}
		cands = append(cands, c)
	}
	return cands, rows.Err()
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
			s.checkDueWatches(ctx)
		}
	}
}

// checkDueWatches runs one pass of WatchLoop over the watches that are due.
func (s *Server) checkDueWatches(ctx context.Context) {
	interval := time.Duration(s.watchInterval()) * time.Minute
	cands, err := s.watchCandidates()
	if err != nil {
		slog.Warn("watch loop: list watches", "err", err)
		return
	}
	now := time.Now()
	for _, c := range cands {
		// shutdown: stop before the next watch, not after all of them
		if ctx.Err() != nil {
			return
		}
		// a check that failed is on its own short backoff: it decides
		// alone, in both directions. Letting the interval rule also
		// speak here would hand a failing watch its normal slot back
		// and undo the wait.
		if c.retryAt > 0 {
			if now.Unix() >= c.retryAt {
				slog.Debug("watch retry due", "id", c.id)
				s.runWatch(ctx, c.id)
			}
			continue
		}
		intervalDue := true
		stale := true // unparseable/empty last_check counts as stale
		if t, err := time.Parse("2006-01-02 15:04:05", c.lastCheck); err == nil {
			intervalDue = !t.Add(interval).After(now.UTC())
			stale = now.UTC().Sub(t) > staleRecheck
		}
		media := s.watchMedia(c.serverID, c.remotePath)
		local := c.localPath
		if c.subfolder {
			local = path.Join(c.localPath, path.Base(c.remotePath))
		}
		minEp := c.fromEpisode
		if c.aired {
			minEp = 0
		}
		have := s.countVideos(local, minEp)
		if stale || smartDue(intervalDue, media, have, watchOffset(c.template), c.fromEpisode, c.filtered, c.aired, watchComplete(media, have), now) {
			slog.Debug("watch due", "id", c.id, "stale", stale,
				"have", have, "fromEpisode", c.fromEpisode, "aired", c.aired, "filtered", c.filtered)
			s.runWatch(ctx, c.id)
		} else {
			// caught up, waiting for the next airing slot (very chatty: per
			// watch, per minute) - TRACE only
			logbus.Trace("watch waiting", "id", c.id, "have", have, "aired", c.aired)
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

// staleRecheck forces a full check on a watch that has not scanned for this
// long, however idle its airing schedule says it is: remote upgrades (v2
// files, better encodes) of already-synced episodes appear without any airing
// event, so a waiting watch would otherwise never see them.
const staleRecheck = 12 * time.Hour

// nextCheckAt is when WatchLoop will look at this watch again: one interval
// after the last check, unless the watch is waiting. A waiting watch skips the
// interval entirely, so what ends the wait decides - its next airing slot, or,
// when the title has no schedule left at all (finished and fully local),
// nothing but the staleRecheck scan for upgrades of already-synced episodes.
// An unparseable or empty last_check means the watch is overdue right now.
// A watch whose last check failed carries a retry_at, and that wins over both.
func nextCheckAt(lastCheck string, interval time.Duration, waiting bool, airingAt int64, retryAt int64, now time.Time) int64 {
	// a failed check overrides everything below: WatchLoop looks at this watch
	// again when the backoff runs out, so saying anything else here would
	// promise a time at which nothing happens
	if retryAt > 0 {
		return retryAt
	}
	last, err := time.Parse("2006-01-02 15:04:05", lastCheck)
	if err != nil {
		return now.Unix()
	}
	at := last.Add(interval)
	if waiting {
		at = last.Add(staleRecheck)
		if slot := time.Unix(airingAt, 0); airingAt > 0 && slot.Before(at) {
			at = slot
			if lo := last.Add(interval); at.Before(lo) {
				at = lo // the release is out, but the interval still has to be due
			}
		}
	}
	return at.Unix()
}

// watchComplete reports a finished title whose episodes are all local. haveEps
// is already scoped to this part (from_episode), so it compares directly
// against the linked entry's episode count.
func watchComplete(media *anilist.Media, haveEps int) bool {
	return media != nil && media.Status == "FINISHED" && media.Episodes > 0 && haveEps >= media.Episodes
}

// smartDue decides whether a watch should check now. Without an AniList
// airing schedule the plain interval rule applies. With one, a watch that
// already holds every aired episode stays idle until the next episode's
// release time. offset maps AniList's absolute episode numbers to the local
// season-relative ones (rename template); fromEpisode is the part's first
// local episode when it shares a season folder. haveEps is the count of the
// part's local files, compared against how many of its episodes have aired.
// filtered is the watch's last_filtered count: remote videos the dub/sub
// filter skipped whose target is not local yet - a backlog waiting on a
// delayed language release (GerDub lagging the JapDub). While it is non-zero
// the watch must keep scanning on the plain interval; the aired branch would
// otherwise go back to sleep as soon as NextAiring rolls to the following
// episode, missing the late release entirely.
func smartDue(intervalDue bool, media *anilist.Media, haveEps, offset, fromEpisode, filtered int, aired, complete bool, now time.Time) bool {
	if !intervalDue {
		return false
	}
	if filtered > 0 {
		return true
	}
	if media == nil || media.NextAiring == nil {
		// no schedule at all: keep the plain interval, we cannot know better.
		// A finished title that is fully local is the exception - nothing new
		// can air, so only the 12h stale re-check has to look for upgrades.
		return !complete
	}
	if aired {
		// endless aired-mapping watch: the local file count spans many seasons
		// and isn't comparable to AniList's absolute aired numbering, so the
		// count check below would never register "caught up". Treat it as caught
		// up (waiting) while the next episode is still unreleased - each sync
		// grabs whatever the remote offers, and the release slot resumes checks.
		return now.Unix() >= media.NextAiring.AiringAt
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
	// no match (or no read) leaves id 0: the watch simply has no media yet
	_ = s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
		serverID, remotePath).Scan(&id, &source)
	if id == 0 {
		return nil
	}
	m, _ := s.sourceMedia(source, id)
	return m
}

// loadWatch reads one watch with everything that decides what its files are
// called.
//
// The rename fields are not optional extras. Anything that has to work out
// which EPISODE a remote file becomes - the sync itself, and the Plex stream
// pass that has to know which episodes a watch covers - reads a wrong answer
// without them rather than an error: watchNameFn sees an empty template, reports
// "no rename configured", and the caller silently falls back to a raw remote
// name that carries an absolute number and no season. That is why there is one
// loader and not a column list per call site.
func (s *Server) loadWatch(id int64) (Watch, bool) {
	var w Watch
	err := s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub, dub_lag_days, plex_audio_lang, plex_sub_lang
		FROM watches WHERE id = ?`, id).
		Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator, &w.TitleOverride, &w.Pattern, &w.Replacement, &w.Subfolder, &w.AiredMapping, &w.RenameProvider, &w.RenameOrdering, &w.RenameTitleLang, &w.RenameSeriesID, &w.WantDub, &w.WantSub, &w.DubLagDays, &w.PlexAudioLang, &w.PlexSubLang)
	return w, err == nil
}

// runWatch checks one watch now: stamps last_check when it goes to the server (self-reset), then
// enqueues missing/changed files through the normal transfer queue. It
// reports what it did for a caller that waits on it; the loop ignores it.
func (s *Server) runWatch(ctx context.Context, id int64) (out WatchCheckResponse) {
	out.Status = "checked"
	// canceled (shutdown, or the waiting request is gone): not started, so
	// neither stamped nor dialed
	if err := ctx.Err(); err != nil {
		out.Error = err.Error()
		return out
	}
	// one check per watch at a time: two listings at once would both find a
	// new file not queued yet and both queue it. A second check waits for the
	// first and then sees what it queued.
	release, err := s.holdWatch(ctx, id)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer release()
	w, ok := s.loadWatch(id)
	if !ok {
		out.Error = "watch not found"
		return out
	}
	nameFn, waiting := s.watchNameFnQuarantine(w, s.unsortedDir(w.UserID))
	// files already collected must not be fetched again: Enqueue only skips
	// what is complete at the EXPECTED target, and theirs is still empty
	skip, err := s.pendingRemotePaths(w.ID)
	if err != nil {
		// not stamped (it never reached the server), but booked like any
		// failed check: a result the overview shows and a backoff, or the loop
		// would start it again on every tick while the watch looks healthy
		slog.Warn("watch check skipped: waiting files unreadable", "watch", w.ID, "err", err)
		out.Error = s.recordWatchFailure(id, err)
		return out
	}
	// the rename setup may have asked a provider; canceled meanwhile: no dial,
	// and no stamp either - a check that never reached the server did not run
	if err := ctx.Err(); err != nil {
		out.Error = err.Error()
		return out
	}
	// a missed timestamp only shows an older check time
	_, _ = s.DB.Exec(`UPDATE watches SET last_check = datetime('now') WHERE id = ?`, id)
	res, err := s.Transfers.EnqueueSkipping(w.UserID, w.ServerID, w.RemotePath, w.LocalPath,
		nameFn, andNotPending(s.watchLangFilter(w), skip), s.watchOwned(w), true, !w.Subfolder, false)
	ids, uploading, filtered, owned := res.IDs, res.Uploading, res.Filtered, res.Owned
	var filteredKeys []int
	for _, t := range res.FilteredTargets {
		if m := epSeasonRe.FindStringSubmatch(filepath.Base(t)); m != nil {
			se, _ := strconv.Atoi(m[1])
			ep, _ := strconv.Atoi(m[2])
			filteredKeys = append(filteredKeys, epKey(se, ep))
		}
	}
	slices.Sort(filteredKeys) // two releases of one episode share a target
	filteredKeys = slices.Compact(filteredKeys)
	if waiting != nil {
		s.rememberPending(w.ID, ids, waiting())
	}
	// a Plex playback preference queues every new download for the post-index
	// stream-selection pass (drained by the sweep once Plex has the file)
	if w.PlexAudioLang != "" || w.PlexSubLang != "" {
		for _, dl := range ids {
			if _, err := s.DB.Exec(`INSERT OR IGNORE INTO plex_stream_queue (download_id, watch_id) VALUES (?, ?)`, dl, id); err != nil {
				slog.Warn("plex stream selection not queued", "watch", id, "download", dl, "err", err)
			}
		}
	}
	// structured result: the frontend localizes the counts; last_result only
	// carries the error text of a failed check
	if err != nil {
		out.Error = s.recordWatchFailure(id, err)
		return out
	}
	queued := len(ids)
	if queued > 0 || uploading > 0 || filtered > 0 {
		slog.Info("watch checked", "id", id, "queued", queued, "uploading", uploading, "filtered", filtered, "owned", owned)
	} else {
		slog.Debug("watch checked", "id", id, "queued", 0, "owned", owned)
	}
	skips := res.Skips
	if skips == nil {
		skips = []transfer.Skip{}
	}
	skipsJSON, _ := json.Marshal(skips)
	// a good check clears the failure count and the backoff
	if _, err := s.DB.Exec(`UPDATE watches SET last_result = '', last_queued = ?, last_uploading = ?, last_filtered = ?, last_filtered_eps = ?,
		last_owned = ?, check_attempts = 0, retry_at = 0, last_skips = ? WHERE id = ?`, queued, uploading, filtered, epKeysCSV(filteredKeys), owned, string(skipsJSON), id); err != nil {
		// the check ran; only its outcome is missing
		slog.Warn("watch check result not saved", "id", id, "err", err)
	}
	out.Queued, out.Uploading, out.Filtered, out.Owned = ids, uploading, filtered, owned
	return out
}

// watchRunKey names one watch of one server: tests run several servers whose
// watch ids overlap.
type watchRunKey struct {
	s  *Server
	id int64
}

// watchRunning holds a one-slot channel per watch, taken while a check runs.
// ponytail: the slots are never dropped; one small channel per watch.
var watchRunning sync.Map // watchRunKey -> chan struct{}

// holdWatch waits until no other check of the watch runs and takes its slot;
// release frees it. A canceled ctx stops the wait.
func (s *Server) holdWatch(ctx context.Context, id int64) (release func(), err error) {
	v, _ := watchRunning.LoadOrStore(watchRunKey{s, id}, make(chan struct{}, 1))
	slot := v.(chan struct{})
	select {
	case slot <- struct{}{}:
		return func() { <-slot }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// recordWatchFailure books a failed check and returns its error text. A check
// that cannot reach the server yet is the common failure, and it is usually
// over in seconds - waiting out a full interval for the next try means the
// episode that just appeared sits there for half an hour. So the consecutive
// failures are counted and the next check is brought forward onto a short
// backoff; a successful check clears both. last_result carries the error,
// last_queued -1 marks the counts as not known.
func (s *Server) recordWatchFailure(id int64, err error) string {
	attempts := 0
	// unreadable counts as the first failure
	_ = s.DB.QueryRow(`SELECT check_attempts FROM watches WHERE id = ?`, id).Scan(&attempts)
	attempts++
	retryAt := time.Now().Add(s.watchBackoff(attempts)).Unix()
	slog.Warn("watch check", "id", id, "attempt", attempts, "err", err)
	if _, dbErr := s.DB.Exec(`UPDATE watches SET last_result = ?, last_queued = -1, last_uploading = 0, last_filtered = 0, last_filtered_eps = '',
		last_owned = 0, check_attempts = ?, retry_at = ?, last_skips = '[]' WHERE id = ?`, err.Error(), attempts, retryAt, id); dbErr != nil {
		// the check failed either way; only its outcome and the backoff are missing
		slog.Warn("watch check result not saved", "id", id, "err", dbErr)
	}
	return err.Error()
}

// watchBackoff staggers the wait before a failed check is repeated: a minute,
// then doubling, held at the watch's own interval. Minutes because WatchLoop
// ticks once a minute - anything finer would be rounded away.
//
// The interval is the ceiling rather than some fixed number of minutes because
// that is the point where the fast lane has nothing left to offer: a watch that
// has been failing for that long is simply back on its ordinary schedule. It is
// also why failed checks are not capped by a count the way downloads are - a
// watch must never stop watching.
func (s *Server) watchBackoff(attempts int) time.Duration {
	ceiling := time.Duration(s.watchInterval()) * time.Minute
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 20 {
		return ceiling // beyond this the shift below would overflow
	}
	if d := time.Minute << (attempts - 1); d < ceiling {
		return d
	}
	return ceiling
}

// watchNameFn maps remote file names to local ones via the watch's rename rule
// (template or regex); unparseable names keep their original. Two independent
// template features may kick in: a localized series title from the provider
// (when a title language is set) replaces {title}, and aired mapping resolves
// each file's absolute episode number to its real broadcast season/episode
// (e.g. 1187 → S34E01) so the template can build a "Season NN/..." path.
//
// See watchNameFnQuarantine for the variant that also reports the files whose
// number the provider did not know.
func (s *Server) watchNameFn(w Watch) func(string) string {
	fn, _ := s.watchNameFnQuarantine(w, "")
	return fn
}

// isMangaWatch reports whether a watch's folder is a manga: matched as one,
// or - while the match of a new watch is still running - holding volumes.
func (s *Server) isMangaWatch(w Watch) bool {
	if w.RemotePath == "" {
		return false // a preview with no folder behind it
	}
	var src string
	if s.DB.QueryRow(`SELECT source FROM catalog_matches WHERE server_id = ? AND folder = ?`, w.ServerID, w.RemotePath).Scan(&src) != nil {
		return s.holdsBooks(w.ServerID, w.RemotePath)
	}
	return src == mangaSource
}

// pendingFile is a downloaded episode whose absolute number the provider did
// not list, so its season is a guess and it waits in the collecting folder.
type pendingFile struct {
	Name  string // the local name it was given, relative to the watch target
	Token string // the absolute number the provider did not know
}

// watchNameFnQuarantine is watchNameFn plus a way out for the files aired
// mapping could not resolve. Renaming those anyway is what files an episode
// under season 1: the template asks for {season}, nothing answered, and
// rename.New defaults it. They go into a collecting folder instead - named
// through the guess, so the folder can be read - and the second return value
// lists them so the caller can remember to fix them later.
//
// dir is that folder's name; empty switches the whole behaviour off, which is
// what the dry-run previews want.
func (s *Server) watchNameFnQuarantine(w Watch, dir string) (func(string) string, func() []pendingFile) {
	o := rename.Options{
		Mode: w.Mode, Template: w.Template, Separator: w.Separator,
		TitleOverride: w.TitleOverride, Pattern: w.Pattern, Replacement: w.Replacement,
	}
	if o.Mode == "" {
		o.Mode = "template"
	}
	if (o.Mode == "template" && o.Template == "") || (o.Mode == "regex" && o.Pattern == "") {
		return nil, nil // no rename configured
	}
	// an episode template turns volumes into SxxEyy; a manga keeps the names
	// it came with unless a regex rule says otherwise
	if o.Mode == "template" && s.isMangaWatch(w) {
		return nil, nil
	}
	// the localized title and aired mapping are independent opt-ins, both only
	// meaningful for the template mode
	useTitle := w.RenameTitleLang != "" && o.Mode == "template"
	useAired := w.AiredMapping && o.Mode == "template"
	var resolver *airmap.Resolver
	var series airmap.Series
	if useTitle || useAired {
		resolver = s.airResolver()
		series = s.watchSeries(w)
		if useTitle && o.TitleOverride == "" {
			// localized series title from the provider, fetched once per check;
			// an explicit TitleOverride in the watch still wins
			if t := resolver.SeriesTitle(context.Background(), series); t != "" {
				o.TitleOverride = t
			}
		}
	}
	var mu sync.Mutex
	var pending []pendingFile
	fn := func(name string) string {
		opts := o
		token := ""
		if useAired && resolver != nil {
			if tok := parseEpisodeToken(name); tok != "" {
				season, ep, ok := resolver.Resolve(context.Background(), series, tok)
				if !ok && dir != "" {
					// the provider has not listed this number yet. Counting on
					// from the newest one it knows gives the file a readable
					// name, but it stays a guess - so it is collected rather
					// than filed, and remembered for a later correction.
					season, ep, ok = resolver.Guess(series, tok)
					token = tok
				}
				if ok {
					opts.SeasonOverride = &season
					opts.EpisodeOverride = &ep
				}
			}
		}
		n, err := rename.New(name, opts)
		if err != nil || n == "" {
			n = name
		}
		if token == "" {
			return n
		}
		n = quarantined(dir, n)
		mu.Lock()
		pending = append(pending, pendingFile{Name: n, Token: token})
		mu.Unlock()
		return n
	}
	return fn, func() []pendingFile {
		mu.Lock()
		defer mu.Unlock()
		return pending
	}
}

// quarantined puts a name into the collecting folder, keeping only its base:
// the template may have produced a "Season NN/" path, and that season is the
// very thing we are unsure about.
func quarantined(dir, name string) string {
	return path.Join(dir, path.Base(name))
}

// airResolver builds the aired-order resolver from the configured providers;
// Plex is nil when not set up, TVDB/TMDB gate themselves on their keys.
func (s *Server) airResolver() *airmap.Resolver {
	return &airmap.Resolver{DB: s.DB, TVDB: s.Tvdb, Plex: s.plexClient(), TMDB: s.Tmdb}
}

// watchSeries builds the rename profile for a watch: the series title/ids plus
// the provider, episode ordering and title language. Defaults are derived from
// what Plex has configured for the matched show (showOrdering + languageOverride),
// then the user's system language, then the global default; an explicit
// per-watch override always wins. AniList links are ignored here - renaming is
// TVDB/TMDB only.
func (s *Server) watchSeries(w Watch) airmap.Series {
	// the rename page works on a local folder and has no remote counterpart,
	// so fall back to the local path for the title guess
	folder := w.RemotePath
	if folder == "" {
		folder = path.Clean(filepath.ToSlash(w.LocalPath))
	}
	ser := airmap.Series{ServerID: w.ServerID, Folder: w.RemotePath, Title: GuessTitle(path.Base(folder))}
	if m := s.watchMedia(w.ServerID, w.RemotePath); m != nil {
		if m.Title.Romaji != "" {
			ser.Title = m.Title.Romaji
		} else if m.Title.English != "" {
			ser.Title = m.Title.English
		}
	}
	var mediaID int
	var source string
	// no match leaves the ids unset, as for a show with no media
	_ = s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
		w.ServerID, w.RemotePath).Scan(&mediaID, &source)
	switch source {
	case "tmdb:tv":
		ser.TMDBTVID = mediaID
	case "tvdb":
		ser.TVDBID = mediaID
	}

	// Plex is the authority for what provider/order/language this show uses
	lang := ""
	if sh, ord, _, ok := s.plexShowForWatch(w, ser.Title); ok {
		if sh.TVDBID != 0 {
			ser.TVDBID = sh.TVDBID
		}
		if sh.TMDBID != 0 {
			ser.TMDBTVID = sh.TMDBID
		}
		ser.Provider, ser.Ordering, lang = ord.Provider, ord.Order, ord.Language
	}
	if lang == "" {
		lang = s.userLocale(w.UserID) // fall back to the user's system language
	}
	ser.TitleLang = lang

	// explicit per-watch overrides win over the Plex-derived defaults
	if w.RenameProvider != "" {
		ser.Provider = w.RenameProvider
	}
	if w.RenameOrdering != "" {
		ser.Ordering = w.RenameOrdering
	}
	// "auto" (and "") keep the Plex/system default language; a concrete tag wins
	if w.RenameTitleLang != "" && w.RenameTitleLang != "auto" {
		ser.TitleLang = w.RenameTitleLang
	}
	// an explicit series id (user picked it when the match was ambiguous) binds
	// the resolver to exactly that series - no guessing via guid/search
	if w.RenameSeriesID != 0 {
		if s.renameProvider(ser.Provider) == "tmdb" {
			ser.TMDBTVID = w.RenameSeriesID
		} else {
			ser.TVDBID = w.RenameSeriesID
		}
	}
	return ser
}

// renameProvider resolves the effective rename provider: the explicit value, or
// TVDB when keyed, else TMDB. Mirrors airmap's default so an explicit series id
// is applied to the same provider the resolver will use.
func (s *Server) renameProvider(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if s.Tvdb != nil && s.Tvdb.Enabled() {
		return "tvdb"
	}
	return "tmdb"
}

// plexShowForWatch locates the Plex show a watch feeds, identity first: the
// series the folder is matched to already carries the tvdb/tmdb ids Plex indexes
// its own library by, so that route needs no title at all. Guessing the title
// from the source folder is the last resort and is usually wrong - Plex names a
// show in the library language ("Yomi no Tsugai" is "Das Band der Unterwelt"
// there) while the source folder romanises it and appends the season.
//
// An empty title switches the title route off.
//
// how names the route that won ("series" | "title"), for the logs. ok=false means
// unresolved: the caller must leave the library alone rather than act on a guess.
func (s *Server) plexShowForWatch(w Watch, title string) (sh *plex.Show, ord plex.Ordering, how string, ok bool) {
	c := s.plexClient()
	if c == nil {
		return nil, plex.Ordering{}, "", false
	}
	if showKey, _, isMovie := s.folderUnit(w.ServerID, w.RemotePath); showKey != "" {
		if rk := s.plexRatingKeyResolveKind(showKey, isMovie); rk != "" {
			if sh, ord, ok := plexShowByKey(c, rk); ok {
				return sh, ord, "series", true
			}
		}
	}
	// the series carries no id Plex shares (an AniList-only match): ask the
	// library about the folder itself, which is what Plex scanned
	target := s.watchTarget(w)
	if rk, ok := c.ShowKeyForPath(target); ok {
		if sh, ord, ok := plexShowByKey(c, rk); ok {
			s.rememberPlexShow(w, sh)
			return sh, ord, "path", true
		}
	}
	if title == "" {
		return nil, plex.Ordering{}, "", false // identity only, no guessing
	}
	sh, ord, ok = s.plexShowFor(title, target)
	if !ok {
		return nil, plex.Ordering{}, "", false
	}
	return sh, ord, "title", true
}

// rememberPlexShow records what the folder walk found, so the next lookup is a
// db read and the series gains every id Plex holds for the show. The binding is
// the scanned folder itself, so it is allowed to unite series those ids name.
func (s *Server) rememberPlexShow(w Watch, sh *plex.Show) {
	seriesID := s.seriesIDForFolder(w.ServerID, w.RemotePath)
	if seriesID == 0 {
		return // folder not bundled yet; the sweep's relinkOrphans catches up
	}
	s.attachPlexIdentity(seriesID, plexGuid{
		TVDB: sh.TVDBID, TMDB: sh.TMDBID, IMDB: sh.IMDBID, Year: sh.Year, RatingKey: sh.RatingKey,
	}, true)
}

// plexShowByKey fetches the show behind a ratingKey with its ordering settings.
func plexShowByKey(c plex.Server, rk string) (*plex.Show, plex.Ordering, bool) {
	detail, err := c.ShowDetail(rk)
	if err != nil {
		return nil, plex.Ordering{}, false
	}
	ord, _ := c.ShowPreferences(rk)
	return detail, ord, true
}

// watchTarget is the folder a watch writes into, absolute. Plex reports absolute
// library roots, so a stored relative path matches nothing until it is resolved.
func (s *Server) watchTarget(w Watch) string {
	local := w.LocalPath
	if w.Subfolder && w.RemotePath != "" {
		local = path.Join(w.LocalPath, path.Base(w.RemotePath))
	}
	if abs, err := s.safeLocal(local); err == nil {
		return abs
	}
	return local
}

// plexShowFor locates the Plex show matching a title (optionally scoped to the
// library owning localPath) and returns it with its ordering/language settings.
// Runs once per watch check, so listing the show sections is affordable.
func (s *Server) plexShowFor(title, localPath string) (*plex.Show, plex.Ordering, bool) {
	c := s.plexClient()
	if c == nil {
		return nil, plex.Ordering{}, false
	}
	secs, err := c.Sections()
	if err != nil {
		return nil, plex.Ordering{}, false
	}
	// prefer the library that owns the local path, if it maps to one
	wantKey := ""
	if lib, ok := c.LibraryForPath(localPath); ok {
		wantKey = lib.Key
	}
	// two match keys: the parsed remote title and the local target folder name.
	// The local folder is usually named exactly as Plex knows the show (the
	// sync target IS the Plex library folder), which matches across languages
	// where the romaji remote title would not (e.g. "Meitantei Conan" folder vs
	// Plex "Detektiv Conan").
	want := match.Normalize(title)
	wantLocal := ""
	if localPath != "" {
		wantLocal = match.Normalize(path.Base(localPath))
	}
	matches := func(name string) bool {
		if name == "" {
			return false
		}
		n := match.Normalize(name)
		return n == want || (wantLocal != "" && n == wantLocal)
	}
	for _, sec := range secs {
		if sec.Type != "show" || (wantKey != "" && sec.Key != wantKey) {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			if !matches(sh.Title) && !matches(sh.OriginalTitle) {
				continue
			}
			detail, err := c.ShowDetail(sh.RatingKey)
			if err != nil {
				return nil, plex.Ordering{}, false
			}
			ord, _ := c.ShowPreferences(sh.RatingKey)
			return detail, ord, true
		}
	}
	return nil, plex.Ordering{}, false
}

// seriesCandidate is one search hit offered when the automatic match is
// ambiguous and the user must pick.
type seriesCandidate struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Year  int    `json:"year"`
}

// renameProfileResponse reports the rename profile Plex has configured for a
// folder's show plus the resolved series match, for prefilling the watch dialog.
type renameProfileResponse struct {
	Detected       bool              `json:"detected"`       // Plex has a per-show ordering
	Provider       string            `json:"provider"`       // ordering provider from Plex: tvdb | tmdb | ""
	Ordering       string            `json:"ordering"`       // official | dvd | absolute | aired | ""
	Language       string            `json:"language"`       // BCP-47 | ""
	ShowTitle      string            `json:"showTitle"`      // the matched Plex show's title
	SeriesProvider string            `json:"seriesProvider"` // provider used to resolve the series id
	SeriesID       int               `json:"seriesId"`       // resolved provider series id, 0 when none
	SeriesTitle    string            `json:"seriesTitle"`    // localized title of the resolved series
	SeriesOriginal string            `json:"seriesOriginal"` // native title, shown in parens
	SeriesURL      string            `json:"seriesUrl"`      // provider page for cross-checking
	SeriesCover    string            `json:"seriesCover"`    // poster url
	SeriesOverview string            `json:"seriesOverview"` // short description
	Ambiguous      bool              `json:"ambiguous"`      // no confident match - the user should pick
	Candidates     []seriesCandidate `json:"candidates,omitempty"`
}

// providerMedia resolves one series' full card from the given provider.
func (s *Server) providerMedia(ctx context.Context, provider string, id int) *anilist.Media {
	switch provider {
	case "tvdb":
		if s.Tvdb != nil {
			m, _ := s.Tvdb.Media(ctx, id)
			return m
		}
	case "tmdb":
		if s.Tmdb != nil {
			m, _ := s.Tmdb.Media(ctx, "tv", id)
			return m
		}
	}
	return nil
}

// seriesHit is one provider search result plus every title it is known by, so
// a query in any language can be matched (TVDB returns the primary name in the
// native language; aliases/translations carry the rest).
type seriesHit struct {
	Media  anilist.Media
	Titles []string
}

// confidentMatch picks the series id whose any known title exactly matches the
// query (normalized). Returns confident=false when nothing is an exact match, so
// the caller can ask the user instead of guessing.
func confidentMatch(query string, hits []seriesHit) (id int, confident bool) {
	want := match.Normalize(query)
	if want == "" {
		return 0, false
	}
	for _, h := range hits {
		for _, ti := range h.Titles {
			if ti != "" && match.Normalize(ti) == want {
				return h.Media.ID, true
			}
		}
	}
	return 0, false
}

// searchSeriesHits searches a provider for series, each with all its titles.
func (s *Server) searchSeriesHits(ctx context.Context, provider, query string) []seriesHit {
	switch provider {
	case "tvdb":
		if s.Tvdb != nil && s.Tvdb.Enabled() {
			hits, _ := s.Tvdb.SearchHits(ctx, query, "")
			out := make([]seriesHit, 0, len(hits))
			for _, h := range hits {
				out = append(out, seriesHit{Media: h.Media, Titles: h.Titles})
			}
			return out
		}
	case "tmdb":
		if s.Tmdb != nil && s.Tmdb.Enabled() {
			list, _ := s.Tmdb.Search(ctx, "tv", query, 0)
			out := make([]seriesHit, 0, len(list))
			for _, m := range list {
				out = append(out, seriesHit{Media: m, Titles: []string{m.Title.Romaji, m.Title.English}})
			}
			return out
		}
	}
	return nil
}

// providerTitle returns a series' localized title from the given provider.
func (s *Server) providerTitle(ctx context.Context, provider string, id int, lang string) string {
	switch provider {
	case "tvdb":
		if s.Tvdb != nil {
			n, _ := s.Tvdb.SeriesTitle(ctx, id, lang)
			return n
		}
	case "tmdb":
		if s.Tmdb != nil {
			n, _ := s.Tmdb.SeriesTitle(ctx, id, lang)
			return n
		}
	}
	return ""
}

// handleRenameProfile returns the Plex-detected rename profile plus the resolved
// series match (or ambiguity + candidates) for a folder, so the watch dialog can
// prefill it and prompt the user when the match isn't unique.
//
//	@Summary		Detected rename profile
//	@Description	Report the provider, episode ordering, language and resolved series (or candidates when ambiguous) for the folder's show.
//	@Tags			Watches
//	@Produce		json
//	@Param			id			path		int		true	"Server id"
//	@Param			path		query		string	true	"Remote folder"
//	@Param			local		query		string	false	"Local target path (library detection)"
//	@Param			provider	query		string	false	"Override rename provider (tvdb | tmdb)"
//	@Success		200			{object}	renameProfileResponse
//	@Failure		404			{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/rename-profile [get]
func (s *Server) handleRenameProfile(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var owned int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned); err != nil {
		dbErr(w, err)
		return
	}
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	ctx := r.Context()
	title := path.Base(r.URL.Query().Get("path"))
	var resp renameProfileResponse

	sh, ord, _, plexOK := s.plexShowForWatch(Watch{
		ServerID:   serverID,
		RemotePath: r.URL.Query().Get("path"),
		LocalPath:  r.URL.Query().Get("local"),
	}, title)
	if plexOK {
		resp.Detected = true
		resp.Provider, resp.Ordering, resp.Language, resp.ShowTitle = ord.Provider, ord.Order, ord.Language, sh.Title
	}

	// effective provider: explicit override → Plex → global default
	prov := r.URL.Query().Get("provider")
	if prov == "" {
		prov = resp.Provider
	}
	if prov == "" {
		prov = s.renameProvider("")
	}
	resp.SeriesProvider = prov

	// series id: prefer the confident Plex guid id, else a confident search hit
	if plexOK {
		if prov == "tmdb" {
			resp.SeriesID = sh.TMDBID
		} else {
			resp.SeriesID = sh.TVDBID
		}
	}
	if resp.SeriesID == 0 {
		hits := s.searchSeriesHits(ctx, prov, GuessTitle(title))
		if id, confident := confidentMatch(GuessTitle(title), hits); confident {
			resp.SeriesID = id
		} else {
			resp.Ambiguous = true
			for i, h := range hits {
				if i >= 6 {
					break
				}
				resp.Candidates = append(resp.Candidates, seriesCandidate{ID: h.Media.ID, Title: h.Media.Title.Romaji, Year: h.Media.SeasonYear})
			}
		}
	}

	if resp.SeriesID != 0 {
		lang := resp.Language
		if lang == "" {
			lang = s.userLocale(u.ID)
		}
		resp.SeriesTitle = s.providerTitle(ctx, prov, resp.SeriesID, lang)
		if m := s.providerMedia(ctx, prov, resp.SeriesID); m != nil {
			// native title: TVDB keeps it in Romaji, TMDB in English
			resp.SeriesOriginal = m.Title.Romaji
			if prov == "tmdb" && m.Title.English != "" {
				resp.SeriesOriginal = m.Title.English
			}
			resp.SeriesURL, resp.SeriesCover, resp.SeriesOverview = m.SiteURL, m.CoverImage.Large, m.Description
			if resp.SeriesTitle == "" {
				resp.SeriesTitle = m.Title.Romaji
			}
			// localized overview (TMDB's Media is already localized to the user's
			// language; TVDB's base record is not, so fetch the translation)
			if prov == "tvdb" && s.Tvdb != nil {
				if o := s.Tvdb.SeriesOverview(ctx, resp.SeriesID, lang); o != "" {
					resp.SeriesOverview = o
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// parseEpisodeToken pulls the episode number token from a file name, or "".
// It keeps the raw value so a fractional special ("1165.5") stays intact for
// the aired-order lookup; regular episodes are the plain number ("1187").
func parseEpisodeToken(name string) string {
	return relname.Read(name).Episode()
}

// watchLangFilter returns a predicate that keeps only remote files whose
// name/folder carries the wanted dub/sub language tag, or nil when the watch
// has no language preference. The full remote path is matched so a
// folder-level tag ("Show [GerDub]/ep01.mkv") applies to every file inside.
// andNotPending narrows a file filter by the remote paths already waiting in
// the collecting folder. Returns nil when neither applies, which Enqueue reads
// as "take everything".
func andNotPending(lang func(string) bool, pending map[string]bool) func(string) bool {
	if len(pending) == 0 {
		return lang
	}
	return func(remotePath string) bool {
		if pending[remotePath] {
			return false
		}
		return lang == nil || lang(remotePath)
	}
}

func (s *Server) watchLangFilter(w Watch) func(string) bool {
	if w.WantDub == "" && w.WantSub == "" {
		return nil
	}
	// a volume has no dub to filter for: a language default on a manga
	// watch would hold back every file without a word about it
	if s.isMangaWatch(w) {
		return nil
	}
	return func(remotePath string) bool {
		// fast path: when the name already carries a tag for every wanted
		// dimension, trust it (no download). Only when a wanted dimension has
		// NO filename tag - the "not everything is in the name" case - do we
		// pull the header and read the real tracks with ffprobe.
		dubTag, subTag := rename.PathLangTags(remotePath)
		ambiguous := (w.WantDub != "" && dubTag == "") || (w.WantSub != "" && subTag == "")
		if !ambiguous {
			return rename.PathLangMatch(remotePath, w.WantDub, w.WantSub)
		}
		dub, sub, ok := s.probeRemoteLang(w.UserID, w.ServerID, remotePath)
		if !ok {
			return rename.PathLangMatch(remotePath, w.WantDub, w.WantSub) // fall back to the name
		}
		if w.WantDub != "" && !dub[canonCode(w.WantDub)] {
			return false
		}
		if w.WantSub != "" && !sub[canonCode(w.WantSub)] {
			return false
		}
		return true
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
	list, err := s.watchesFor(u.ID)
	if err != nil {
		dbErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// watchesFor is a user's auto-syncs as the overview shows them: metadata,
// local file count, gaps, what is airing next. Shared by the list endpoint
// and the assistant's airing tool.
func (s *Server) watchesFor(userID int64) ([]Watch, error) {
	interval := s.watchInterval()
	rows, err := s.DB.Query(`SELECT w.id, w.user_id, w.server_id, s.name, w.remote_path, w.local_path,
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.subfolder, w.from_episode, w.aired_mapping, w.rename_provider, w.rename_ordering, w.rename_title_lang, w.rename_series_id, w.want_dub, w.want_sub, w.dub_lag_days, w.plex_audio_lang, w.plex_sub_lang, w.plex_stream_miss, w.last_check, w.last_result, w.last_queued, w.last_uploading, w.last_filtered, w.last_filtered_eps, w.last_owned, w.check_attempts, w.retry_at, w.created_at
		FROM watches w JOIN servers s ON s.id = w.server_id
		WHERE w.user_id = ? ORDER BY w.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	progress := s.anilistProgress(userID)
	list := []Watch{}
	for rows.Next() {
		var it Watch
		var retryAt int64
		var langWaitingEps string
		if err := rows.Scan(&it.ID, &it.UserID, &it.ServerID, &it.ServerName, &it.RemotePath, &it.LocalPath,
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement, &it.Subfolder, &it.FromEpisode, &it.AiredMapping, &it.RenameProvider, &it.RenameOrdering, &it.RenameTitleLang, &it.RenameSeriesID, &it.WantDub, &it.WantSub, &it.DubLagDays, &it.PlexAudioLang, &it.PlexSubLang, &it.PlexStreamMiss,
			&it.LastCheck, &it.LastResult, &it.LastQueued, &it.LastUploading, &it.LangWaiting, &langWaitingEps, &it.LastOwned, &it.CheckAttempts, &retryAt, &it.CreatedAt); err != nil {
			return nil, err
		}
		it.IntervalMin = interval
		it.Media = s.watchMedia(it.ServerID, it.RemotePath)
		local := it.LocalPath
		if it.Subfolder {
			local = path.Join(it.LocalPath, path.Base(it.RemotePath))
		}
		// fromEpisode scopes a single shared-season folder to one part; an
		// aired-mapping watch spans whole seasons, so that filter doesn't apply.
		minEp := it.FromEpisode
		if it.AiredMapping {
			minEp = 0
		}
		it.LocalFiles = s.countVideos(local, minEp)
		// one walk for the gap list, the seasons and the dub tags of the names
		var localNums map[int]bool
		dubTags := map[int]string{}
		src := s.downloadSources(userID, local)
		s.walkEpisodes(local, minEp, func(k int, p string, _ int64) {
			if localNums == nil {
				localNums = map[int]bool{}
			}
			localNums[k] = true
			// a renamed file keeps its dub in the release it came from;
			// untagged either way, it stays in as saying nothing
			d, _ := rename.LangTags(filepath.Base(p))
			if d == "" {
				d, _ = rename.LangTags(path.Base(src[p]))
			}
			dubTags[k] += d + ","
		})
		it.Missing = missingEpisodes(localNums)
		it.LangWaitingEps = parseEpKeys(langWaitingEps)
		// the seasons the watch is about: on disk, and the ones only waiting
		// for their language yet (a new season with nothing local)
		seasonKeys := maps.Clone(localNums)
		for _, r := range it.LangWaitingEps {
			if seasonKeys == nil {
				seasonKeys = map[int]bool{}
			}
			seasonKeys[epKey(r.Season, r.Episode)] = true
		}
		it.Seasons = localSeasons(seasonKeys)
		it.Unsorted = s.pendingCount(it.ID)
		under, underArgs := subtreeCond("remote_path", it.RemotePath)
		// a failed count shows no active downloads on this card
		_ = s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ?
			AND status IN ('queued','running','paused') AND `+under,
			append([]any{userID, it.ServerID}, underArgs...)...).Scan(&it.Active)
		offset := watchOffset(it.Template)
		it.Offset = offset
		// The older files carry a dub the newer ones lack: the dub is still
		// coming, so the title is not done. A dub filter only gates the first
		// download, it does not make the other languages stop counting.
		it.DubProgress = dubProgressOf(dubTags)
		it.Complete = watchComplete(it.Media, it.LocalFiles) && it.Active == 0 && it.DubProgress == nil
		if it.Media != nil {
			it.MediaID = it.Media.ID
			it.SeenEpisodes = progress[it.Media.ID]
			// surface the match source so the edit dialog prefills the right
			// provider and the UI can drop anime-only cosmetics (JST) for TMDB
			// cosmetic: without the source the dialog falls back to its default
			_ = s.DB.QueryRow(`SELECT source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
				it.ServerID, it.RemotePath).Scan(&it.MediaSource)
		}
		if it.Media != nil && it.Media.NextAiring != nil {
			it.NextEpisode = it.Media.NextAiring.Episode + offset
			if offset != 0 {
				it.NextEpisodeAbs = it.Media.NextAiring.Episode // show absolute in parens
			}
			it.NextAiringAt = it.Media.NextAiring.AiringAt
			// aired per AniList but not yet local - the source release can lag
			// the original broadcast; auto-sync keeps checking and grabs them
			start := it.FromEpisode
			if start < 1 {
				start = 1
			}
			// Behind counts aired-but-not-local against AniList's absolute
			// numbering; meaningless for an aired-mapping watch, which tracks a
			// rolling window of an endless series, not the full back catalogue.
			if aired := it.Media.NextAiring.Episode + offset - start; aired > it.LocalFiles && !it.AiredMapping {
				it.Behind = aired - it.LocalFiles
			}
		}
		// outside the airing branch: a watch also waits when its title is
		// finished and fully local, and that one has no NextAiring at all
		now := time.Now()
		it.Waiting = !smartDue(true, it.Media, it.LocalFiles, offset, it.FromEpisode, it.LangWaiting, it.AiredMapping, watchComplete(it.Media, it.LocalFiles), now)
		it.NextCheck = nextCheckAt(it.LastCheck, time.Duration(interval)*time.Minute, it.Waiting, it.NextAiringAt, retryAt, now)
		if it.Media != nil {
			it.Category = watchCategory(it.MediaSource, it.Media, s.tvdbAnime(it.MediaSource, it.MediaID))
			start := it.FromEpisode
			// The week just gone comes from the recorder - the providers drop a
			// slot the moment it airs - and the rest from whatever they have
			// dated ahead. A slot both sides know about is listed once.
			from := now.Add(-airingsLookback)
			slots := s.pastAirings(it.MediaSource, it.MediaID, from, now)
			for _, a := range it.Media.Airings() {
				slots = append(slots, Airing{At: a.AiringAt, Episode: a.Episode})
			}
			// keyed on both: TMDB dates an episode to a day, so two episodes
			// airing the same day share a timestamp and both belong in the list
			type slotKey struct {
				at int64
				ep int
			}
			seen := map[slotKey]bool{}
			for _, a := range slots {
				k := slotKey{a.At, a.Episode}
				if a.At < from.Unix() || seen[k] || a.Episode+offset < start {
					continue // older than the calendar reaches, already listed, or an earlier part of a shared folder
				}
				seen[k] = true
				air := Airing{At: a.At, Episode: a.Episode + offset}
				if offset != 0 {
					air.EpisodeAbs = a.Episode
				}
				it.Airings = append(it.Airings, air)
			}
			// The dub the watch filters for gets slots of its own: the
			// releases recorded in that language, and for the rest of the
			// original slots a projection (see dubSlots).
			behindTrack := "" // the slots Behind is counted against
			if lang := dubLang(it.WantDub); lang != "" {
				dubbed, fc := s.dubSlots(it.MediaSource, it.MediaID, lang, it.DubLagDays, slots, from, offset, start)
				it.Airings = append(it.Airings, dubbed...)
				// the episode the dub is waited for, in local numbering
				it.DubNextEpisode = max(start, 1) + it.LocalFiles
				// A dub watch is measured against the dub schedule, not the
				// original broadcast: trailing the original is the deal, not
				// a problem. Without a known lag the original stays the ruler.
				if fc.Known && !it.AiredMapping {
					behindTrack = lang
					origBehind := it.Behind
					behind, expectedAt, overdue := dubStanding(fc, offset, start, it.LocalFiles, now)
					if it.Media != nil && it.Media.NextAiring != nil {
						it.Behind = min(behind, origBehind) // the dub is never ahead of the original
					} else {
						it.Behind = behind
					}
					if it.Behind == 0 && (origBehind > 0 || it.LangWaiting > 0) {
						it.DubWaiting = true
						it.DubExpectedAt = expectedAt
						it.DubOverdue = overdue
					}
				}
			}
			sort.Slice(it.Airings, func(i, j int) bool {
				if it.Airings[i].At != it.Airings[j].At {
					return it.Airings[i].At < it.Airings[j].At
				}
				if it.Airings[i].Episode != it.Airings[j].Episode {
					return it.Airings[i].Episode < it.Airings[j].Episode
				}
				return it.Airings[i].Dub < it.Airings[j].Dub
			})
			if !it.AiredMapping {
				lang := dubLang(it.WantDub)
				// what an upload trails: the dub release on a dub watch, the broadcast otherwise
				base := map[int]int64{}
				for _, a := range s.langAirings(it.MediaSource, it.MediaID, lang) {
					base[a.Episode+offset] = a.At
				}
				if lang == "" {
					for _, a := range slots {
						base[a.Episode+offset] = a.At
					}
				}
				markAirings(it.Airings, localNums, s.firstSeen(userID, it.ServerID, it.RemotePath), base, lang)
				// measured against the original, Behind also holds what the
				// source has but only in another language: that is waiting
				// for the dub (LangWaiting), not missing from the source
				if behindTrack == "" && (it.WantDub != "" || it.WantSub != "") {
					it.Behind = max(0, it.Behind-it.LangWaiting)
				}
				it.BehindLate = behindLate(it.Behind, it.Airings, behindTrack, now)
			}
			if p := it.DubProgress; p != nil {
				lang := dubLang(p.Lang)
				// every recorded original, not just the calendar's week: a
				// finished title's next dubbed episode aired weeks before it
				orig := append(s.langAirings(it.MediaSource, it.MediaID, ""), slots...)
				dubbed, fc := s.dubSlots(it.MediaSource, it.MediaID, lang, 0, orig, from, offset, start)
				// the calendar shows the trailing dub too; a slot is had once
				// the local file of that episode carries the dub
				for i := range dubbed {
					dubbed[i].Have = hasDub(dubTags[epKey(p.Next.Season, dubbed[i].Episode)], lang)
				}
				it.Airings = append(it.Airings, dubbed...)
				sort.SliceStable(it.Airings, func(i, j int) bool { return it.Airings[i].At < it.Airings[j].At })
				// out already: the source is what lags, not the dub
				for _, a := range fc.Released {
					if a.Episode == p.Next.Episode-offset && a.At <= now.Unix() {
						p.ExpectedAt, p.Released = a.At, true
					}
				}
				if at, ok := fc.OrigAt[p.Next.Episode-offset]; ok && fc.Known && !p.Released {
					p.ExpectedAt = at + fc.Lag
				}
			}
		}
		it.Attention = watchAttention(it)
		list = append(list, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// watchAttention is THE needs-a-hand predicate, worst first. Expected
// waiting is not attention: an episode the source has not uploaded yet only
// counts once it is late (BehindLate), a language backlog is the dub not
// being out yet, and only an overdue dub is a reason of its own. Neither is
// a gap or a backlog before a check has queued anything or while downloads
// of the watch still run: a new watch fetches every aired episode at once,
// and until they land it would read as all of them late. LastQueued, not
// LastCheck: the check stamps that before it lists the source.
func watchAttention(w Watch) []string {
	var out []string
	settled := w.LastQueued != -1 && w.Active == 0
	if w.LastResult != "" {
		out = append(out, "checkFailed")
	}
	if w.Behind > 0 && w.BehindLate && settled {
		out = append(out, "behind")
	}
	if len(w.Missing) > 0 && settled {
		out = append(out, "missing")
	}
	if w.DubOverdue {
		out = append(out, "dubOverdue")
	}
	if w.Unsorted > 0 {
		out = append(out, "unsorted")
	}
	if w.PlexStreamMiss != "" {
		out = append(out, "plexStreamMiss")
	}
	return out
}

var epNumRe = regexp.MustCompile(`(?i)S\d+E(\d+)`)

// epSeasonRe captures both season and episode, so gap detection can scope
// episode numbers per season (an aired-mapping watch spans many seasons, each
// restarting at E01 - a flat span would report every cross-season number as a
// bogus gap).
var epSeasonRe = regexp.MustCompile(`(?i)S(\d+)E(\d+)`)

// countVideos counts local video files, and the volumes of a manga watch
// (no folder holds both). When minEp > 0, only files whose
// SxxEyy episode number is >= minEp count - for watches that share a season
// folder with earlier parts (e.g. Dr. Stone S4 Part 3 starts at E26, Conan
// S33 at E31), so only this part's episodes are tallied.
func (s *Server) countVideos(rel string, minEp int) int {
	n := 0
	for _, v := range s.localFiles(rel) {
		ext := strings.ToLower(filepath.Ext(v.name))
		if !videoExt[ext] && !transfer.BookExt[ext] {
			continue
		}
		if minEp > 0 {
			m := epNumRe.FindStringSubmatch(v.name)
			if m == nil {
				continue
			}
			if ep, _ := strconv.Atoi(m[1]); ep < minEp {
				continue
			}
		}
		n++
	}
	return n
}

// seasonStride encodes (season, episode) into one int as season*stride+episode.
// It has to exceed any real episode number, or the encoding wraps: with a
// stride of 1000, a stray "S01E1208" (an absolute number left in the episode
// field) landed on the same key as S02E208 and gave season 2 a span of 1..208 -
// 181 gaps reported for a season that was complete.
const seasonStride = 100000

// maxEpisode is the largest episode number a season can plausibly hold. Beyond
// that the name carries an absolute number in the episode field, and letting it
// set the span would invent gaps for every number in between.
const maxEpisode = 999

// firstSeen is when each episode of a watch first turned up on the server:
// the first time a check queued its file, keyed on the episode number the
// file was renamed to. Good to one check interval.
//
// ponytail: read from the download history, so a cleared history forgets the
// sightings until new ones come in; a table of its own is the upgrade if that
// bites.
func (s *Server) firstSeen(userID, serverID int64, remotePath string) map[int]int64 {
	under, underArgs := subtreeCond("remote_path", remotePath)
	rows, err := s.DB.Query(`SELECT local_path, MIN(created_at) FROM downloads
		WHERE user_id = ? AND server_id = ? AND `+under+` GROUP BY local_path`,
		append([]any{userID, serverID}, underArgs...)...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	seen := map[int]int64{}
	for rows.Next() {
		var local, created string
		if rows.Scan(&local, &created) != nil {
			continue
		}
		m := epSeasonRe.FindStringSubmatch(path.Base(local))
		t, terr := time.Parse(time.DateTime, created)
		if m == nil || terr != nil {
			continue
		}
		ep, _ := strconv.Atoi(m[2])
		if at := t.Unix(); seen[ep] == 0 || at < seen[ep] {
			seen[ep] = at
		}
	}
	if rows.Err() != nil {
		return nil
	}
	return seen
}

// markAirings tells each calendar slot whether its episode is on disk, and
// for the track the watch fetches (lang, "" = the original) when the file
// reached the server or should: a sighting where there is one, else the slot
// plus the watch's own upload lag - the median over its newest three
// sightings against base, the time each episode was released.
func markAirings(airings []Airing, local map[int]bool, seen map[int]int64, base map[int]int64, lang string) {
	have := map[int]bool{}
	for k := range local {
		if se, ep := splitEpKey(k); se != 0 {
			have[ep] = true
		}
	}
	var sightings []Airing
	for ep, at := range seen {
		sightings = append(sightings, Airing{At: at, Episode: ep})
	}
	lag, known := lagFromReleases(sightings, base)
	for i := range airings {
		a := &airings[i]
		a.Have = have[a.Episode]
		if a.Dub != lang {
			continue
		}
		if at, ok := seen[a.Episode]; ok {
			a.RemoteAt = at
		} else if known {
			a.RemoteAt, a.RemoteEst = a.At+lag, true
		}
	}
}

func epKey(season, episode int) int { return season*seasonStride + episode }

func splitEpKey(k int) (season, episode int) { return k / seasonStride, k % seasonStride }

// localEpisodeNums returns the set of SxxEyy episode numbers present locally
// (only files >= minEp when minEp > 0). Used for gap detection - files without a
// parseable episode number are ignored.
func (s *Server) localEpisodeNums(rel string, minEp int) map[int]bool {
	counts := s.localEpisodeCounts(rel, minEp)
	if counts == nil {
		return nil
	}
	nums := make(map[int]bool, len(counts))
	for k := range counts {
		nums[k] = true
	}
	return nums
}

// localEpisodeCounts is localEpisodeNums with the number of files per episode,
// so a folder holding an episode twice under two names can be told apart.
func (s *Server) localEpisodeCounts(rel string, minEp int) map[int]int {
	var nums map[int]int
	s.walkEpisodes(rel, minEp, func(k int, _ string, _ int64) {
		if nums == nil {
			nums = map[int]int{}
		}
		nums[k]++
	})
	return nums
}

// localEpisodeFiles lists the video files per SxxEyy key, so the duplicates
// view can name the files an episode is held in twice.
func (s *Server) localEpisodeFiles(rel string) map[int][]DuplicateFile {
	out := map[int][]DuplicateFile{}
	s.walkEpisodes(rel, 0, func(k int, path string, size int64) {
		out[k] = append(out[k], DuplicateFile{Path: path, Bytes: size})
	})
	return out
}

// walkEpisodes calls fn for every video file under rel that carries an
// SxxEyy number (only episodes >= minEp when minEp > 0), with the file's path
// in the caller's form (rel joined with the path below it) and its size.
// downloadSources maps each local file below rel to the remote path of the
// last finished download that wrote it; empty when nothing did or the
// history was cleared. The history stores absolute paths while a watch may
// keep its folder relative to a root, so the keys are spelled like rel.
//
// ponytail: no index on downloads.local_path, a range scan over the history
// per watch; add one if the history ever grows past a few thousand rows.
func (s *Server) downloadSources(userID int64, rel string) map[string]string {
	abs := strings.TrimRight(s.localAbs(rel), "/")
	under, args := subtreeCond("local_path", abs)
	rows, err := s.DB.Query(`SELECT local_path, remote_path FROM downloads
		WHERE user_id = ? AND status = 'done' AND `+under+` ORDER BY id`, append([]any{userID}, args...)...)
	if err != nil {
		return nil // reads as untagged, nothing worse
	}
	defer rows.Close()
	src := map[string]string{}
	for rows.Next() {
		var l, r string
		if rows.Scan(&l, &r) != nil {
			return nil
		}
		src[filepath.Join(rel, strings.TrimPrefix(l, abs))] = r // a later replacement wins
	}
	if rows.Err() != nil {
		return nil // a half-read list is none at all
	}
	return src
}

func (s *Server) walkEpisodes(rel string, minEp int, fn func(key int, path string, size int64)) {
	for _, v := range s.localFiles(rel) {
		if !videoExt[strings.ToLower(filepath.Ext(v.name))] {
			continue
		}
		m := epSeasonRe.FindStringSubmatch(v.name)
		if m == nil {
			continue
		}
		se, _ := strconv.Atoi(m[1])
		ep, _ := strconv.Atoi(m[2])
		if ep >= minEp && ep <= maxEpisode {
			// season-encoded so gaps stay per-season
			fn(epKey(se, ep), filepath.Join(rel, v.sub), v.size)
		}
	}
}

// missingEpisodes returns the gaps WITHIN the contiguous span of local episodes,
// i.e. between the lowest and highest number present (e.g. {1,2,3,5} → [4]).
// Only holes inside what you already have count - a partial start or a Behind
// tail are not gaps. nums are season-encoded (see epKey) and gaps are
// computed within each season's own lo..hi span, so a multi-season (aired-
// mapping) watch never reports the cross-season number range as missing.
func missingEpisodes(nums map[int]bool) []EpRef {
	if len(nums) < 2 {
		return nil
	}
	bySeason := map[int]map[int]bool{}
	for k := range nums {
		se, ep := splitEpKey(k)
		if se == 0 {
			continue // season 0 = specials; their numbering is inherently sparse
		}
		if bySeason[se] == nil {
			bySeason[se] = map[int]bool{}
		}
		bySeason[se][ep] = true
	}
	var missing []EpRef
	for se, eps := range bySeason {
		lo, hi := 1<<31, 0
		for e := range eps {
			if e < lo {
				lo = e
			}
			if e > hi {
				hi = e
			}
		}
		for e := lo + 1; e < hi; e++ {
			if !eps[e] {
				missing = append(missing, EpRef{se, e})
			}
		}
	}
	sortEpRefs(missing)
	return missing
}

// behindGrace is how long an aired episode may be missing from the source
// before Behind stops being the usual upload lag.
const behindGrace = 2 * 24 * time.Hour

// behindLate reports whether behind episodes are more than the releases of
// the last behindGrace on the given track (dub tag, "" = original) explain.
func behindLate(behind int, airings []Airing, track string, now time.Time) bool {
	if behind == 0 {
		return false
	}
	recent := 0
	for _, a := range airings {
		if a.Dub == track && !a.Est && !a.Have && a.At <= now.Unix() && a.At > now.Add(-behindGrace).Unix() {
			recent++
		}
	}
	return behind > recent
}

// DubProgress is how far a dub has come: the older episodes are dubbed, the
// newer not yet.
type DubProgress struct {
	Lang       string `json:"lang"`                 // the code as the names spell it (Ger, Eng, ...)
	Have       int    `json:"have"`                 // local episodes carrying it
	Total      int    `json:"total"`                // local episodes
	Next       EpRef  `json:"next"`                 // first episode after the last dubbed one
	ExpectedAt int64  `json:"expectedAt,omitempty"` // forecast of Next's dub; 0 = no date known
	Released   bool   `json:"released,omitempty"`   // Next's dub is out already, ExpectedAt is when
}

// dubProgressOf reads the dub tags of a folder's names (episode key -> tags)
// for a dub that stops partway: on older episodes, missing on the newest
// tagged one. No language is assumed to be the original - whatever the
// newest episode carries is, so Japanese for anime and English, German or
// anything else for live action drop out alike. Of several trailing dubs the
// one with the most episodes wins. Untagged names say nothing.
//
// ponytail: names only. A source switch that drops a language for good
// (E1-10 EngJapDub, E11 on JapDub) reads as a trailing dub; probing the
// audio tracks would be the upgrade path.
func dubProgressOf(tags map[int]string) *DubProgress {
	if len(tags) == 0 {
		return nil
	}
	var keys []int
	for k := range tags {
		if se, _ := splitEpKey(k); se != 0 {
			keys = append(keys, k)
		}
	}
	sort.Ints(keys)
	have, last, spelled := map[string]int{}, map[string]int{}, map[string]string{}
	newest := 0 // the newest episode with any tag
	for _, k := range keys {
		seen := map[string]bool{}
		for _, c := range rename.Codes(tags[k]) {
			l := langCode(c)
			if l == "" || seen[l] {
				continue
			}
			seen[l] = true
			have[l]++
			last[l] = k
			newest = k
			if spelled[l] == "" {
				spelled[l] = c
			}
		}
	}
	best := ""
	for l, n := range have {
		if last[l] == newest {
			continue // the original, or a dub that has caught up
		}
		if best == "" || n > have[best] || (n == have[best] && l < best) {
			best = l
		}
	}
	if best == "" {
		return nil
	}
	i := sort.SearchInts(keys, last[best]) + 1
	se, ep := splitEpKey(keys[i])
	// how far, within the season the next episode belongs to: a folder with
	// a finished earlier season would otherwise read 28/34 for 13/19
	p := &DubProgress{Lang: spelled[best], Next: EpRef{se, ep}}
	for _, k := range keys {
		if s, _ := splitEpKey(k); s == se {
			p.Total++
			if k < keys[i] {
				p.Have++
			}
		}
	}
	return p
}

// hasDub reports whether a name's dub tags (as dubProgressOf reads them)
// carry the dub of a language (de, en, ...).
func hasDub(tags, lang string) bool {
	for _, c := range rename.Codes(tags) {
		if dubLang(c) == lang {
			return true
		}
	}
	return false
}

// localSeasons lists the seasons among season-encoded keys, specials left out.
func localSeasons(nums map[int]bool) []int {
	seen := map[int]bool{}
	var out []int
	for k := range nums {
		if se, _ := splitEpKey(k); se != 0 && !seen[se] {
			seen[se] = true
			out = append(out, se)
		}
	}
	sort.Ints(out)
	return out
}

// epKeysCSV and parseEpKeys carry a list of season-encoded keys through a
// text column.
func epKeysCSV(keys []int) string {
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = strconv.Itoa(k)
	}
	return strings.Join(parts, ",")
}

func parseEpKeys(csv string) []EpRef {
	var out []EpRef
	for _, p := range strings.Split(csv, ",") {
		if k, err := strconv.Atoi(p); err == nil {
			se, ep := splitEpKey(k)
			out = append(out, EpRef{se, ep})
		}
	}
	sortEpRefs(out)
	return out
}

// EpRef names one episode with its season, so a watch spanning several
// seasons can say which E05 it means.
type EpRef struct {
	Season  int `json:"s"`
	Episode int `json:"e"`
}

func (r EpRef) String() string { return fmt.Sprintf("S%02dE%02d", r.Season, r.Episode) }

func sortEpRefs(l []EpRef) {
	sort.Slice(l, func(i, j int) bool {
		if l[i].Season != l[j].Season {
			return l[i].Season < l[j].Season
		}
		return l[i].Episode < l[j].Episode
	})
}

// WriteCheckError is the error body of a save rejected because the local target
// cannot be written. It carries the same classification the downloads use, so
// the dialog can explain the failure at once instead of the user discovering it
// minutes later as a failed download with a raw Go error on it.
// The two extra fields are absent on an ordinary 400, which carries a bare
// error message.
type WriteCheckError struct {
	Error     string `json:"error"`
	ErrorCode string `json:"errorCode,omitempty"` // permission_denied | disk_full | read_only | rename_failed
	Path      string `json:"path,omitempty"`      // the directory that refused the write
}

// rejectUnwritable probes the watch's local target and, if it cannot be written,
// answers with the classification. Only a classified failure is a rejection: an
// unresolvable root or a plain I/O error says nothing the user could act on, and
// blocking the save on it would trade a clear problem for a mysterious one.
func (s *Server) rejectUnwritable(w http.ResponseWriter, localPath string) bool {
	if werr := s.unwritableTarget(localPath); werr != nil {
		writeJSON(w, http.StatusBadRequest, *werr)
		return true
	}
	return false
}

// unwritableTarget is the probe behind rejectUnwritable, usable without a
// response writer (the legacy import reports it per row): nil when the target
// is writable or the failure is not one the user could act on.
func (s *Server) unwritableTarget(localPath string) *WriteCheckError {
	local, err := s.openLocal(localPath)
	if err != nil {
		return nil // already validated by the caller
	}
	defer local.Close()
	code, cerr := transfer.CheckWritableAt(local)
	if code == "" {
		return nil
	}
	return &WriteCheckError{Error: cerr.Error(), ErrorCode: code, Path: local.Abs}
}

// handleWatchCreate registers a new watch and triggers a first sync.
//
// @Summary      Create watch
// @Description  Registers a new persistent watch on a remote folder, optionally linking media metadata, and kicks off a first sync immediately. The local target is probed for writability and the watch is rejected when it cannot be written.
// @Tags         Watches
// @Accept       json
// @Produce      json
// @Param        body  body  Watch  true  "Watch definition (serverId and remotePath required)"
// @Success      201  {object}  WatchCreateResponse
// @Failure      400  {object}  WriteCheckError  "invalid input; errorCode and path are set when the local target refused a write"
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches [post]
func (s *Server) handleWatchCreate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in Watch
	if !readJSON(w, r, &in) {
		return
	}
	adminFields(u, &in, nil)
	if in.ServerID == 0 || in.RemotePath == "" {
		writeErr(w, http.StatusBadRequest, "serverId and remotePath required")
		return
	}
	if _, err := s.safeLocal(in.LocalPath); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var owned int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, in.ServerID, u.ID).Scan(&owned); err != nil {
		dbErr(w, err)
		return
	}
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
	if !validWatchRule(w, in.Mode, in.Pattern, in.FromEpisode, in.RenameSeriesID, in.RenameProvider, in.RenameOrdering) || !validDubLag(w, in.DubLagDays) {
		return
	}
	// a target the container cannot write is worth catching here: otherwise the
	// watch saves fine and only its downloads fail, minutes later, out of sight
	if s.rejectUnwritable(w, in.LocalPath) {
		return
	}
	res, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, from_episode, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub, dub_lag_days, plex_audio_lang, plex_sub_lang)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.ServerID, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub, in.DubLagDays, in.PlexAudioLang, in.PlexSubLang)
	if err != nil {
		if db.IsUnique(err) {
			writeErr(w, http.StatusConflict, "watch already exists")
			return
		}
		dbErr(w, err)
		return
	}
	id, _ := res.LastInsertId()
	s.linkMedia(in.ServerID, in.RemotePath, in.MediaID, in.MediaSource)
	if in.MediaID <= 0 {
		s.ensureWatchMatch(in.ServerID, in.RemotePath, in.LocalPath)
	}
	s.spawn(func() { s.runWatch(s.lifetimeCtx(), id) }) // first sync right away
	writeJSON(w, http.StatusCreated, WatchCreateResponse{ID: id})
}

// handleWatchUpdate edits an existing watch; a path change re-checks the folder.
//
// @Summary      Update watch
// @Description  Updates an existing watch's paths, rename rule, media link and language filters. Changing the remote or local path triggers an immediate re-check. The local target is probed for writability and the update is rejected when it cannot be written. With moveFiles the old target folder's entries are moved into the new one first (within one media root, never overwriting).
// @Tags         Watches
// @Accept       json
// @Produce      json
// @Param        id    path  int     true  "Watch ID"
// @Param        body  body  object  true  "Watch fields to update (remotePath required)"
// @Success      200  {object}  watchUpdateResponse
// @Failure      400  {object}  WriteCheckError  "invalid input; errorCode and path are set when the local target refused a write"
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse  "a duplicate watch, or the files could not be moved (moveFiles)"
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/watches/{id} [put]
func (s *Server) handleWatchUpdate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var in struct {
		RemotePath      string `json:"remotePath"`
		LocalPath       string `json:"localPath"`
		Mode            string `json:"mode"`
		Template        string `json:"template"`
		Separator       string `json:"separator"`
		TitleOverride   string `json:"titleOverride"`
		Pattern         string `json:"pattern"`
		Replacement     string `json:"replacement"`
		Subfolder       bool   `json:"subfolder"`
		MediaID         int    `json:"mediaId"`
		MediaSource     string `json:"mediaSource"`
		FromEpisode     int    `json:"fromEpisode"`
		AiredMapping    bool   `json:"airedMapping"`
		RenameProvider  string `json:"renameProvider"`
		RenameOrdering  string `json:"renameOrdering"`
		RenameTitleLang string `json:"renameTitleLang"`
		RenameSeriesID  int    `json:"renameSeriesId"`
		WantDub         string `json:"wantDub"`
		WantSub         string `json:"wantSub"`
		DubLagDays      int    `json:"dubLagDays"`
		PlexAudioLang   string `json:"plexAudioLang"`
		PlexSubLang     string `json:"plexSubLang"`
		// MoveFiles takes what the old target folder holds along to the new one
		MoveFiles bool `json:"moveFiles"`
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
	if !validWatchRule(w, in.Mode, in.Pattern, in.FromEpisode, in.RenameSeriesID, in.RenameProvider, in.RenameOrdering) || !validDubLag(w, in.DubLagDays) {
		return
	}
	var oldRemote, oldLocal, oldAudio, oldSub string
	var serverID int64
	var oldSubfolder bool
	if err := s.DB.QueryRow(`SELECT server_id, remote_path, local_path, plex_audio_lang, plex_sub_lang, subfolder FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).
		Scan(&serverID, &oldRemote, &oldLocal, &oldAudio, &oldSub, &oldSubfolder); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "watch not found")
			return
		}
		dbErr(w, err)
		return
	}
	// moving a folder's contents reaches into the shared library, whatever
	// the watch's own files are: an admin's
	if in.MoveFiles && !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "admin only: moveFiles")
		return
	}
	if !u.IsAdmin {
		in.PlexAudioLang, in.PlexSubLang = oldAudio, oldSub
	}
	// same as on create: say so now, not through a failed download later
	if s.rejectUnwritable(w, in.LocalPath) {
		return
	}
	// the files follow the target before it is saved: a move that fails leaves
	// the watch on the folder its files are still in
	var moved *moveResult
	if from, to := watchFolder(oldLocal, oldRemote, oldSubfolder), watchFolder(in.LocalPath, in.RemotePath, in.Subfolder); in.MoveFiles && from != to {
		// another watch filling the same folder would lose its files to the move
		other, err := s.sharedWatchFolder(id, from)
		if err != nil {
			dbErr(w, err)
			return
		}
		if other != "" {
			writeErr(w, http.StatusConflict, "files not moved: another watch ("+logSafe(other)+") uses the same folder")
			return
		}
		res, err := s.moveFolderContents(from, to)
		if err != nil {
			writeErr(w, http.StatusConflict, "files not moved: "+err.Error())
			return
		}
		moved = &res
	}
	_, err := s.DB.Exec(`UPDATE watches SET remote_path = ?, local_path = ?, mode = ?, template = ?, separator = ?, title_override = ?, pattern = ?, replacement = ?, subfolder = ?, from_episode = ?, aired_mapping = ?, rename_provider = ?, rename_ordering = ?, rename_title_lang = ?, rename_series_id = ?, want_dub = ?, want_sub = ?, dub_lag_days = ?, plex_audio_lang = ?, plex_sub_lang = ?
		WHERE id = ? AND user_id = ?`, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub, in.DubLagDays, in.PlexAudioLang, in.PlexSubLang, id, u.ID)
	if err != nil {
		if db.IsUnique(err) {
			writeErr(w, http.StatusConflict, "watch already exists")
			return
		}
		dbErr(w, err)
		return
	}
	s.linkMedia(serverID, in.RemotePath, in.MediaID, in.MediaSource)
	if in.MediaID <= 0 {
		s.ensureWatchMatch(serverID, in.RemotePath, in.LocalPath)
	}
	if in.RemotePath != oldRemote || in.LocalPath != oldLocal {
		s.spawn(func() { s.runWatch(s.lifetimeCtx(), id) }) // paths changed: check the new folder right away
	}
	// The queue only ever covers downloads that come AFTER the preference was
	// set, so changing it used to do nothing at all to the episodes already in
	// the library. Apply it to them now, and drop the old verdict: it describes
	// a question nobody is asking anymore.
	if in.PlexAudioLang != oldAudio || in.PlexSubLang != oldSub {
		if _, err := s.DB.Exec(`UPDATE watches SET plex_stream_miss = '' WHERE id = ?`, id); err != nil {
			slog.Warn("plex stream verdict not cleared", "watch", id, "err", err)
		}
		// re-read rather than assemble from the request: the pass has to know
		// how this watch names its files, and a literal built here would carry
		// no rename at all
		if wt, ok := s.loadWatch(id); ok && (wt.PlexAudioLang != "" || wt.PlexSubLang != "") {
			s.applyPlexStreamsJob(wt)
		}
	}
	writeJSON(w, http.StatusOK, watchUpdateResponse{Status: "ok", Moved: moved})
}

// watchUpdateResponse confirms a watch update; Moved is set when its files
// were taken along to a new target folder.
type watchUpdateResponse struct {
	Status string      `json:"status" example:"ok"`
	Moved  *moveResult `json:"moved,omitempty"`
}

// linkMedia records a manual folder→media match so the overview shows real
// metadata (cover, episodes, airing) for a watch whose folder the catalog
// couldn't auto-match (e.g. an arc subfolder). id 0 leaves any match as-is.
// source is the metadata provider: "anilist" (anime), "tmdb:tv"/"tmdb:movie"
// or "tvdb" (live action); anything else falls back to anilist.
//
// The edit dialog sends back whatever match the folder already has, so the
// same pair is no decision: it leaves an automatic match automatic. Taking
// it as one froze every wrong guess of the matcher the first time someone
// saved the watch, and nothing re-matches a manual row.
func (s *Server) linkMedia(serverID int64, folder string, mediaID int, source string) {
	if mediaID <= 0 {
		return
	}
	if source != "tmdb:tv" && source != "tmdb:movie" && source != "tvdb" && source != tvdbMovieSource && source != mangaSource {
		source = "anilist"
	}
	var have int
	var haveSource string
	if s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&have, &haveSource) == nil && have == mediaID && haveSource == source {
		return
	}
	if err := s.persistMatch(serverID, folder, mediaID, true, source); err != nil {
		slog.Warn("watch media not linked", "folder", logSafe(folder), "err", err)
	}
}

// ensureWatchMatch queues a metadata match for a watch folder the catalog has
// not matched yet, so an auto-sync created from the browser or the assistant
// gets its title, cover and airing data like any catalog folder - a folder
// outside every catalog view would otherwise stay bare until someone opened
// it there. A stored miss (media_id 0) is searched again, past the search
// cache that holds the empty answer; a manual unmatch is left alone. Reports
// whether a match was queued.
//
// The source follows the catalog mark on the remote side, else the Plex
// library the watch writes into: an unscoped folder would otherwise always be
// searched on AniList, which knows no western shows. A match from another
// source than that is searched again, so switching a library to TVDB moves
// its folders over instead of leaving them on the AniList guess.
func (s *Server) ensureWatchMatch(serverID int64, folder, localPath string) bool {
	return s.matchWatch(serverID, folder, localPath, false)
}

// matchWatch is ensureWatchMatch; overrule also searches a manual match again
// when it comes from another source than the folder's scope. Only for passes
// that follow a change of that source: whoever switches a library to TVDB
// wants rid of the AniList pick, and the edit dialog used to stamp every
// automatic match as manual on save, so the flag says little about a match
// from before.
func (s *Server) matchWatch(serverID int64, folder, localPath string, overrule bool) bool {
	var mediaID, manual int
	var source string
	stored := s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&mediaID, &manual, &source) == nil
	name, scope := s.watchMatchQuery(serverID, folder, localPath)
	if stored && source == mangaSource {
		scope = "manga" // a manga stays a manga; its tree often carries no mark
	}
	// no mark and no library says nothing about the source: what is stored stays
	foreign := stored && scope != "" && expectedSource(scope, source) != source && (manual == 0 || overrule) &&
		!s.anilistAgreesWithPlex(mediaID, source, localPath)
	if stored && !foreign && (mediaID != 0 || manual == 1) {
		return false
	}
	if foreign {
		slog.Info("watch folder matched again", "folder", logSafe(folder), "from", source, "to", expectedSource(scope, source), "manual", manual == 1)
		// the index row carries the show key of the old match
		if _, err := s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = ? AND folder = ?`, serverID, folder); err != nil {
			slog.Warn("stale index row kept", "folder", logSafe(folder), "err", err)
		}
	}
	s.queueScopedMatch(serverID, folder, name, scope, stored)
	return true
}

// folderSource is the source a folder is matched on, the one answer the
// catalogue and the auto-sync both go by: the mark on its parent, else for a
// watched folder what matchWatch searches it in (the library it writes into,
// books as manga) - unless its stored match already stands there - else the
// source its match has.
func (s *Server) folderSource(serverID int64, folder string) string {
	name := path.Base(folder)
	var stored string
	var mediaID int
	// no stored match (or no read): the folder counts as unmatched
	_ = s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&stored, &mediaID)
	if scope := s.scopeFor(serverID, path.Dir(folder)); scope != "" {
		return expectedSource(scopeForItem(scope, s.itemKind(serverID, folder, name)), stored)
	}
	var local string
	if s.DB.QueryRow(`SELECT local_path FROM watches WHERE server_id = ? AND remote_path = ? LIMIT 1`,
		serverID, folder).Scan(&local) == nil {
		if _, scope := s.watchMatchQuery(serverID, folder, local); scope != "" &&
			stored != mangaSource && !s.anilistAgreesWithPlex(mediaID, stored, local) {
			return expectedSource(scope, stored)
		}
	}
	if stored != "" {
		return stored
	}
	return "anilist"
}

// anilistAgreesWithPlex reports whether an AniList match names the same show
// as the Plex library the watch writes into: the anime mapping files the entry
// under the TVDB or TMDB id that Plex reports for the show at the local
// folder. An anime library ordered by TVDB holds AniList matches on purpose
// (absolute episode numbers, airing times), and those are not foreign to it;
// a guess that only shares a name ("Dragon, Ie wo Kau." for House of the
// Dragon) maps to another show than Plex has there.
func (s *Server) anilistAgreesWithPlex(mediaID int, source, localPath string) bool {
	if source != "anilist" || mediaID == 0 {
		return false
	}
	ids, ok := s.animeIDs(mediaID)
	if !ok {
		return false
	}
	target := s.localAbs(localPath)
	if target == "" {
		return false
	}
	// the Plex index stores a show per season folder: the watch may write into
	// the show, one of its seasons or a folder below one
	rows, err := s.DB.Query(`SELECT DISTINCT show_key FROM catalog_variants
		WHERE server_id = 0 AND (folder = ?1 OR folder >= ?1 || '/' AND folder < ?1 || '0' OR ?1 >= folder || '/' AND ?1 < folder || '0')`,
		target)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if rows.Scan(&key) != nil {
			continue
		}
		if (ids.tvdbID > 0 && key == "tvdb:"+strconv.Itoa(ids.tvdbID)) ||
			(ids.tmdbID > 0 && key == "tmdb:"+strconv.Itoa(ids.tmdbID)) {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("plex library check", "err", err)
	}
	return false
}

// watchMatchQuery is the search name and scope of a watch folder.
func (s *Server) watchMatchQuery(serverID int64, folder, localPath string) (name, scope string) {
	titleDir, name := path.Dir(folder), path.Base(folder)
	// a season folder ("S06", "Season 2", "Staffel.5") names no title: the
	// show folder above it does, and the season rides along for the matcher
	if m := seasonDirNameRe.FindStringSubmatch(name); m != nil && titleDir != "/" && titleDir != "." {
		n, _ := strconv.Atoi(m[1])
		name = path.Base(titleDir) + " Season " + strconv.Itoa(n)
		titleDir = path.Dir(titleDir)
	}
	scope = s.scopeFor(serverID, titleDir)
	if scope == "" {
		scope = s.plexLibraryScope(s.localAbs(localPath))
	}
	if (scope == "" || scope == "anime") && s.holdsBooks(serverID, folder) {
		scope = "manga"
	}
	return name, scopeForItem(scope, s.itemKind(serverID, folder, name))
}

// localAbs is a watch's local path made absolute, the form Plex
// library roots are in: a relative local path lives under the download root.
func (s *Server) localAbs(localPath string) string {
	if abs, err := s.safeLocal(localPath); err == nil && !path.IsAbs(localPath) {
		return abs
	}
	return localPath
}

// holdsBooks reports whether a remote folder holds manga or novel volumes and
// no video, so a watch on it is matched against manga without a mark - manga
// trees shelve titles under letter folders, often more than one level below
// any folder that could carry one. The remote index decides; a folder it has
// not reached yet falls back to a "manga" somewhere in its path.
func (s *Server) holdsBooks(serverID int64, folder string) bool {
	var books, videos, seen int
	rows, err := s.DB.Query(`SELECT name FROM remote_index WHERE server_id = ? AND parent = ? AND is_dir = 0`, serverID, folder)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var n string
			if rows.Scan(&n) != nil {
				seen = 0 // half a listing is no evidence: fall back to the path
				break
			}
			seen++
			ext := strings.ToLower(path.Ext(n))
			if transfer.BookExt[ext] {
				books++
			} else if videoExt[ext] {
				videos++
			}
		}
		if rows.Err() != nil {
			seen = 0 // half a listing is no evidence: fall back to the path
		}
	}
	if seen > 0 {
		return books > 0 && videos == 0
	}
	// ponytail: path heuristic until the crawler has listed the folder
	return strings.Contains(strings.ToLower(path.Dir(folder)), "manga")
}

// seasonDirNameRe matches a folder that is only a season marker. Anchored: a
// title merely starting with "S " is a title.
var seasonDirNameRe = regexp.MustCompile(`(?i)^(?:s|season[ ._-]?|staffel[ ._-]?)(\d{1,3})$`)

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
		dbErr(w, err)
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
// @Param        id    path   int     true   "Watch ID"
// @Param        wait  query  string  false  "1: run the check now and answer with what it did (200)"
// @Success      200  {object}  WatchCheckResponse
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
	if err := s.DB.QueryRow(q, args...).Scan(&owned); err != nil {
		dbErr(w, err)
		return
	}
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	// a button that turns into the progress of what it started has to know
	// what that was: wait=1 runs the check in the request
	if r.URL.Query().Get("wait") == "1" {
		writeJSON(w, http.StatusOK, s.runWatch(context.WithoutCancel(r.Context()), id))
		return
	}
	s.spawn(func() { s.runWatch(s.lifetimeCtx(), id) })
	writeJSON(w, http.StatusAccepted, WatchCheckResponse{Status: "checking"})
}

// adminFields drops what only an admin may ask of a sync or a watch: moving
// the old copies of an episode aside reaches files anyone may have put in the
// shared library, and the Plex track choices act on the admin's Plex account.
// keep holds a watch's stored track choices on an update (nil: none kept).
func adminFields(u *auth.User, in *Watch, keep *Watch) {
	if u.IsAdmin {
		return
	}
	in.ReplaceOld = false
	in.PlexAudioLang, in.PlexSubLang = "", ""
	if keep != nil {
		in.PlexAudioLang, in.PlexSubLang = keep.PlexAudioLang, keep.PlexSubLang
	}
}
