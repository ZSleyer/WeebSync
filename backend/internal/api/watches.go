package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
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
	"github.com/ch4d1/weebsync/internal/rename"
	"github.com/ch4d1/weebsync/internal/transfer"
	"github.com/nssteinbrenner/anitogo"
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
			rows, err := s.DB.Query(`SELECT id, server_id, remote_path, local_path, subfolder, template, from_episode, aired_mapping, last_filtered, last_check, retry_at FROM watches`)
			if err != nil {
				continue
			}
			type cand struct {
				id                                         int64
				serverID                                   int64
				remotePath, localPath, template, lastCheck string
				subfolder                                  bool
				fromEpisode                                int
				aired                                      bool
				filtered                                   int
				retryAt                                    int64
			}
			var cands []cand
			for rows.Next() {
				var c cand
				rows.Scan(&c.id, &c.serverID, &c.remotePath, &c.localPath, &c.subfolder, &c.template, &c.fromEpisode, &c.aired, &c.filtered, &c.lastCheck, &c.retryAt)
				cands = append(cands, c)
			}
			rows.Close()
			now := time.Now()
			for _, c := range cands {
				// a check that failed is on its own short backoff: it decides
				// alone, in both directions. Letting the interval rule also
				// speak here would hand a failing watch its normal slot back
				// and undo the wait.
				if c.retryAt > 0 {
					if now.Unix() >= c.retryAt {
						slog.Debug("watch retry due", "id", c.id)
						s.runWatch(c.id)
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
					s.runWatch(c.id)
				} else {
					// caught up, waiting for the next airing slot (very chatty: per
					// watch, per minute) - TRACE only
					logbus.Trace("watch waiting", "id", c.id, "have", have, "aired", c.aired)
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
	s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
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
	err := s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub, plex_audio_lang, plex_sub_lang
		FROM watches WHERE id = ?`, id).
		Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator, &w.TitleOverride, &w.Pattern, &w.Replacement, &w.Subfolder, &w.AiredMapping, &w.RenameProvider, &w.RenameOrdering, &w.RenameTitleLang, &w.RenameSeriesID, &w.WantDub, &w.WantSub, &w.PlexAudioLang, &w.PlexSubLang)
	return w, err == nil
}

// runWatch checks one watch now: stamps last_check first (self-reset), then
// enqueues missing/changed files through the normal transfer queue.
func (s *Server) runWatch(id int64) {
	w, ok := s.loadWatch(id)
	if !ok {
		return
	}
	s.DB.Exec(`UPDATE watches SET last_check = datetime('now') WHERE id = ?`, id)

	nameFn, waiting := s.watchNameFnQuarantine(w, s.unsortedDir(w.UserID))
	// files already collected must not be fetched again: Enqueue only skips
	// what is complete at the EXPECTED target, and theirs is still empty
	skip := s.pendingRemotePaths(w.ID)
	res, err := s.Transfers.Enqueue(w.UserID, w.ServerID, w.RemotePath, w.LocalPath,
		nameFn, andNotPending(s.watchLangFilter(w), skip), true, !w.Subfolder, false)
	ids, uploading, filtered := res.IDs, res.Uploading, res.Filtered
	if waiting != nil {
		s.rememberPending(w.ID, ids, waiting())
	}
	// a Plex playback preference queues every new download for the post-index
	// stream-selection pass (drained by the sweep once Plex has the file)
	if w.PlexAudioLang != "" || w.PlexSubLang != "" {
		for _, dl := range ids {
			s.DB.Exec(`INSERT OR IGNORE INTO plex_stream_queue (download_id, watch_id) VALUES (?, ?)`, dl, id)
		}
	}
	// structured result: the frontend localizes the counts; last_result only
	// carries the error text of a failed check
	result, queued := "", len(ids)
	// A check that cannot reach the server yet is the common failure, and it is
	// usually over in seconds - waiting out a full interval for the next try
	// means the episode that just appeared sits there for half an hour. Count
	// the consecutive failures and bring the next check forward onto a short
	// backoff; a successful check clears both.
	attempts, retryAt := 0, int64(0)
	if err != nil {
		s.DB.QueryRow(`SELECT check_attempts FROM watches WHERE id = ?`, id).Scan(&attempts)
		attempts++
		retryAt = time.Now().Add(s.watchBackoff(attempts)).Unix()
		result, queued, uploading, filtered = err.Error(), -1, 0, 0
		slog.Warn("watch check", "id", id, "attempt", attempts, "err", err)
	} else if queued > 0 || uploading > 0 || filtered > 0 {
		slog.Info("watch checked", "id", id, "queued", queued, "uploading", uploading, "filtered", filtered)
	} else {
		slog.Debug("watch checked", "id", id, "queued", 0)
	}
	s.DB.Exec(`UPDATE watches SET last_result = ?, last_queued = ?, last_uploading = ?, last_filtered = ?,
		check_attempts = ?, retry_at = ? WHERE id = ?`, result, queued, uploading, filtered, attempts, retryAt, id)
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
	s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
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
// how names the route that won ("series" | "title"), for the logs. ok=false means
// unresolved: the caller must leave the library alone rather than act on a guess.
func (s *Server) plexShowForWatch(w Watch, title string) (sh *plex.Show, ord plex.Ordering, how string, ok bool) {
	c := s.plexClient()
	if c == nil {
		return nil, plex.Ordering{}, "", false
	}
	if showKey, _, _ := s.folderUnit(w.ServerID, w.RemotePath); showKey != "" {
		if rk := s.plexRatingKeyResolve(showKey); rk != "" {
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
func plexShowByKey(c *plex.Client, rk string) (*plex.Show, plex.Ordering, bool) {
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
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned)
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
	p := anitogo.Parse(name, anitogo.DefaultOptions)
	if len(p.EpisodeNumber) == 0 {
		return ""
	}
	// same normalisation the template path uses: anitogo hands back "E01" for
	// some names, and the aired-order map is keyed by the bare number
	return rename.EpisodeNumber(p.EpisodeNumber[0])
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
	return func(remotePath string) bool {
		// fast path: when the name already carries a tag for every wanted
		// dimension, trust it (no download). Only when a wanted dimension has
		// NO filename tag - the "not everything is in the name" case - do we
		// pull the header and read the real tracks with ffprobe.
		dubTag, subTag := rename.LangTags(remotePath)
		ambiguous := (w.WantDub != "" && dubTag == "") || (w.WantSub != "" && subTag == "")
		if !ambiguous {
			return rename.LangMatch(remotePath, w.WantDub, w.WantSub)
		}
		dub, sub, ok := s.probeRemoteLang(w.UserID, w.ServerID, remotePath)
		if !ok {
			return rename.LangMatch(remotePath, w.WantDub, w.WantSub) // fall back to the name
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
	interval := s.watchInterval()
	rows, err := s.DB.Query(`SELECT w.id, w.user_id, w.server_id, s.name, w.remote_path, w.local_path,
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.subfolder, w.from_episode, w.aired_mapping, w.rename_provider, w.rename_ordering, w.rename_title_lang, w.rename_series_id, w.want_dub, w.want_sub, w.plex_audio_lang, w.plex_sub_lang, w.plex_stream_miss, w.last_check, w.last_result, w.last_queued, w.last_uploading, w.last_filtered, w.check_attempts, w.retry_at, w.created_at
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
		var retryAt int64
		if err := rows.Scan(&it.ID, &it.UserID, &it.ServerID, &it.ServerName, &it.RemotePath, &it.LocalPath,
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement, &it.Subfolder, &it.FromEpisode, &it.AiredMapping, &it.RenameProvider, &it.RenameOrdering, &it.RenameTitleLang, &it.RenameSeriesID, &it.WantDub, &it.WantSub, &it.PlexAudioLang, &it.PlexSubLang, &it.PlexStreamMiss,
			&it.LastCheck, &it.LastResult, &it.LastQueued, &it.LastUploading, &it.LangWaiting, &it.CheckAttempts, &retryAt, &it.CreatedAt); err != nil {
			dbErr(w)
			return
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
		it.Missing = missingEpisodes(s.localEpisodeNums(local, minEp))
		it.Unsorted = s.pendingCount(it.ID)
		s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND server_id = ?
			AND status IN ('queued','running','paused') AND remote_path LIKE ? || '%'`,
			u.ID, it.ServerID, it.RemotePath).Scan(&it.Active)
		offset := watchOffset(it.Template)
		it.Offset = offset
		it.Complete = watchComplete(it.Media, it.LocalFiles) && it.Active == 0
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
			it.Category = watchCategory(it.MediaSource, it.Media)
			start := it.FromEpisode
			for _, a := range it.Media.FutureAirings() {
				if a.AiringAt <= now.Unix() || a.Episode+offset < start {
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

// epSeasonRe captures both season and episode, so gap detection can scope
// episode numbers per season (an aired-mapping watch spans many seasons, each
// restarting at E01 - a flat span would report every cross-season number as a
// bogus gap).
var epSeasonRe = regexp.MustCompile(`(?i)S(\d+)E(\d+)`)

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
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return skipTrash(d)
		}
		if !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
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
	abs, err := s.safeLocal(rel)
	if err != nil {
		return nil
	}
	nums := map[int]int{}
	filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return skipTrash(d)
		}
		if !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		m := epSeasonRe.FindStringSubmatch(d.Name())
		if m == nil {
			return nil
		}
		se, _ := strconv.Atoi(m[1])
		ep, _ := strconv.Atoi(m[2])
		if ep >= minEp && ep <= maxEpisode {
			nums[epKey(se, ep)]++ // season-encoded so gaps stay per-season
		}
		return nil
	})
	return nums
}

// missingEpisodes returns the gaps WITHIN the contiguous span of local episodes,
// i.e. between the lowest and highest number present (e.g. {1,2,3,5} → [4]).
// Only holes inside what you already have count - a partial start or a Behind
// tail are not gaps. nums are season-encoded (see epKey) and gaps are
// computed within each season's own lo..hi span, so a multi-season (aired-
// mapping) watch never reports the cross-season number range as missing.
func missingEpisodes(nums map[int]bool) []int {
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
	var missing []int
	for _, eps := range bySeason {
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
				missing = append(missing, e)
			}
		}
	}
	sort.Ints(missing)
	return missing
}

// WriteCheckError is the error body of a save rejected because the local target
// cannot be written. It carries the same classification the downloads use, so
// the dialog can explain the failure at once instead of the user discovering it
// minutes later as a failed download with a raw Go error on it.
// The two extra fields are absent on an ordinary 400, which carries a bare
// error message.
type WriteCheckError struct {
	Error     string `json:"error"`
	ErrorCode string `json:"errorCode,omitempty"` // permission_denied | disk_full | read_only
	Path      string `json:"path,omitempty"`      // the directory that refused the write
}

// rejectUnwritable probes the watch's local target and, if it cannot be written,
// answers with the classification. Only a classified failure is a rejection: an
// unresolvable root or a plain I/O error says nothing the user could act on, and
// blocking the save on it would trade a clear problem for a mysterious one.
func (s *Server) rejectUnwritable(w http.ResponseWriter, localPath string) bool {
	abs, err := s.safeLocal(localPath)
	if err != nil {
		return false // already validated by the caller
	}
	code, cerr := transfer.CheckWritable(abs)
	if code == "" {
		return false
	}
	writeJSON(w, http.StatusBadRequest, WriteCheckError{Error: cerr.Error(), ErrorCode: code, Path: abs})
	return true
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
	// a target the container cannot write is worth catching here: otherwise the
	// watch saves fine and only its downloads fail, minutes later, out of sight
	if s.rejectUnwritable(w, in.LocalPath) {
		return
	}
	res, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, from_episode, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub, plex_audio_lang, plex_sub_lang)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.ServerID, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub, in.PlexAudioLang, in.PlexSubLang)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	id, _ := res.LastInsertId()
	s.linkMedia(in.ServerID, in.RemotePath, in.MediaID, in.MediaSource)
	if in.MediaID <= 0 {
		s.ensureWatchMatch(in.ServerID, in.RemotePath)
	}
	go s.runWatch(id) // first sync right away
	writeJSON(w, http.StatusCreated, WatchCreateResponse{ID: id})
}

// handleWatchUpdate edits an existing watch; a path change re-checks the folder.
//
// @Summary      Update watch
// @Description  Updates an existing watch's paths, rename rule, media link and language filters. Changing the remote or local path triggers an immediate re-check. The local target is probed for writability and the update is rejected when it cannot be written.
// @Tags         Watches
// @Accept       json
// @Produce      json
// @Param        id    path  int     true  "Watch ID"
// @Param        body  body  object  true  "Watch fields to update (remotePath required)"
// @Success      200  {object}  OkResponse
// @Failure      400  {object}  WriteCheckError  "invalid input; errorCode and path are set when the local target refused a write"
// @Failure      404  {object}  ErrorResponse
// @Failure      409  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
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
		PlexAudioLang   string `json:"plexAudioLang"`
		PlexSubLang     string `json:"plexSubLang"`
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
	var oldRemote, oldLocal, oldAudio, oldSub string
	var serverID int64
	if err := s.DB.QueryRow(`SELECT server_id, remote_path, local_path, plex_audio_lang, plex_sub_lang FROM watches WHERE id = ? AND user_id = ?`, id, u.ID).
		Scan(&serverID, &oldRemote, &oldLocal, &oldAudio, &oldSub); err != nil {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}
	// same as on create: say so now, not through a failed download later
	if s.rejectUnwritable(w, in.LocalPath) {
		return
	}
	_, err := s.DB.Exec(`UPDATE watches SET remote_path = ?, local_path = ?, mode = ?, template = ?, separator = ?, title_override = ?, pattern = ?, replacement = ?, subfolder = ?, from_episode = ?, aired_mapping = ?, rename_provider = ?, rename_ordering = ?, rename_title_lang = ?, rename_series_id = ?, want_dub = ?, want_sub = ?, plex_audio_lang = ?, plex_sub_lang = ?
		WHERE id = ? AND user_id = ?`, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub, in.PlexAudioLang, in.PlexSubLang, id, u.ID)
	if err != nil {
		writeErr(w, http.StatusConflict, "watch already exists")
		return
	}
	s.linkMedia(serverID, in.RemotePath, in.MediaID, in.MediaSource)
	if in.MediaID <= 0 {
		s.ensureWatchMatch(serverID, in.RemotePath)
	}
	if in.RemotePath != oldRemote || in.LocalPath != oldLocal {
		go s.runWatch(id) // paths changed: check the new folder right away
	}
	// The queue only ever covers downloads that come AFTER the preference was
	// set, so changing it used to do nothing at all to the episodes already in
	// the library. Apply it to them now, and drop the old verdict: it describes
	// a question nobody is asking anymore.
	if in.PlexAudioLang != oldAudio || in.PlexSubLang != oldSub {
		s.DB.Exec(`UPDATE watches SET plex_stream_miss = '' WHERE id = ?`, id)
		// re-read rather than assemble from the request: the pass has to know
		// how this watch names its files, and a literal built here would carry
		// no rename at all
		if wt, ok := s.loadWatch(id); ok && (wt.PlexAudioLang != "" || wt.PlexSubLang != "") {
			s.applyPlexStreamsJob(wt)
		}
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

// ensureWatchMatch queues a metadata match for a watch folder the catalog has
// not matched yet, so an auto-sync created from the browser or the assistant
// gets its title, cover and airing data like any catalog folder - a folder
// outside every catalog view would otherwise stay bare until someone opened
// it there. Reports whether a match was queued.
func (s *Server) ensureWatchMatch(serverID int64, folder string) bool {
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE server_id = ? AND folder = ?`, serverID, folder).Scan(&n)
	if n > 0 {
		return false
	}
	name := path.Base(folder)
	scope := scopeForItem(s.scopeFor(serverID, path.Dir(folder)), s.itemKind(serverID, folder, name))
	s.queueScopedMatch(serverID, folder, name, scope, false)
	return true
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
