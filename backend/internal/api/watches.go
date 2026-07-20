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
	"time"

	"github.com/ch4d1/weebsync/internal/airmap"
	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
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
	IntervalMin     int    `json:"intervalMin"`     // global setting, echoed for the UI
	LastCheck       string `json:"lastCheck"`
	LastResult      string `json:"lastResult"`    // error text of the last check, "" on success
	LastQueued      int    `json:"lastQueued"`    // files queued at the last check, -1 = none yet
	LastUploading   int    `json:"lastUploading"` // files still uploading remotely at the last check
	LangWaiting     int    `json:"langWaiting"`   // videos on the remote skipped by the dub/sub filter, target not yet local
	CreatedAt       string `json:"createdAt"`

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
	err := s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub
		FROM watches WHERE id = ?`, id).
		Scan(&w.ID, &w.UserID, &w.ServerID, &w.RemotePath, &w.LocalPath, &w.Mode, &w.Template, &w.Separator, &w.TitleOverride, &w.Pattern, &w.Replacement, &w.Subfolder, &w.AiredMapping, &w.RenameProvider, &w.RenameOrdering, &w.RenameTitleLang, &w.RenameSeriesID, &w.WantDub, &w.WantSub)
	if err != nil {
		return
	}
	s.DB.Exec(`UPDATE watches SET last_check = datetime('now') WHERE id = ?`, id)

	ids, uploading, filtered, err := s.Transfers.Enqueue(w.UserID, w.ServerID, w.RemotePath, w.LocalPath, s.watchNameFn(w), watchLangFilter(w), true, !w.Subfolder)
	// structured result: the frontend localizes the counts; last_result only
	// carries the error text of a failed check
	result, queued := "", len(ids)
	if err != nil {
		result, queued, uploading, filtered = err.Error(), -1, 0, 0
		slog.Warn("watch check", "id", id, "err", err)
	}
	s.DB.Exec(`UPDATE watches SET last_result = ?, last_queued = ?, last_uploading = ?, last_filtered = ? WHERE id = ?`, result, queued, uploading, filtered, id)
}

// watchNameFn maps remote file names to local ones via the watch's rename rule
// (template or regex); unparseable names keep their original. Two independent
// template features may kick in: a localized series title from the provider
// (when a title language is set) replaces {title}, and aired mapping resolves
// each file's absolute episode number to its real broadcast season/episode
// (e.g. 1187 → S34E01) so the template can build a "Season NN/..." path.
func (s *Server) watchNameFn(w Watch) func(string) string {
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
	return func(name string) string {
		opts := o
		if useAired && resolver != nil {
			if tok := parseEpisodeToken(name); tok != "" {
				if season, ep, ok := resolver.Resolve(context.Background(), series, tok); ok {
					opts.SeasonOverride = &season
					opts.EpisodeOverride = &ep
				}
			}
		}
		n, err := rename.New(name, opts)
		if err != nil || n == "" {
			return name
		}
		return n
	}
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
	ser := airmap.Series{ServerID: w.ServerID, Folder: w.RemotePath, Title: GuessTitle(path.Base(w.RemotePath))}
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
	if sh, ord, ok := s.plexShowFor(ser.Title, w.LocalPath); ok {
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

	sh, ord, plexOK := s.plexShowFor(title, r.URL.Query().Get("local"))
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
	return p.EpisodeNumber[0]
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
			w.mode, w.template, w.separator, w.title_override, w.pattern, w.replacement, w.subfolder, w.from_episode, w.aired_mapping, w.rename_provider, w.rename_ordering, w.rename_title_lang, w.rename_series_id, w.want_dub, w.want_sub, w.last_check, w.last_result, w.last_queued, w.last_uploading, w.last_filtered, w.created_at
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
			&it.Mode, &it.Template, &it.Separator, &it.TitleOverride, &it.Pattern, &it.Replacement, &it.Subfolder, &it.FromEpisode, &it.AiredMapping, &it.RenameProvider, &it.RenameOrdering, &it.RenameTitleLang, &it.RenameSeriesID, &it.WantDub, &it.WantSub,
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
		// fromEpisode scopes a single shared-season folder to one part; an
		// aired-mapping watch spans whole seasons, so that filter doesn't apply.
		minEp := it.FromEpisode
		if it.AiredMapping {
			minEp = 0
		}
		it.LocalFiles = s.countVideos(local, minEp)
		it.Missing = missingEpisodes(s.localEpisodeNums(local, minEp))
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
			// Behind counts aired-but-not-local against AniList's absolute
			// numbering; meaningless for an aired-mapping watch, which tracks a
			// rolling window of an endless series, not the full back catalogue.
			if aired := it.Media.NextAiring.Episode + offset - start; aired > it.LocalFiles && !it.AiredMapping {
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
		m := epSeasonRe.FindStringSubmatch(d.Name())
		if m == nil {
			return nil
		}
		se, _ := strconv.Atoi(m[1])
		ep, _ := strconv.Atoi(m[2])
		if ep >= minEp {
			nums[se*1000+ep] = true // season-encoded so gaps stay per-season
		}
		return nil
	})
	return nums
}

// missingEpisodes returns the gaps WITHIN the contiguous span of local episodes,
// i.e. between the lowest and highest number present (e.g. {1,2,3,5} → [4]).
// Only holes inside what you already have count - a partial start or a Behind
// tail are not gaps. nums are season-encoded (season*1000+episode) and gaps are
// computed within each season's own lo..hi span, so a multi-season (aired-
// mapping) watch never reports the cross-season number range as missing.
func missingEpisodes(nums map[int]bool) []int {
	if len(nums) < 2 {
		return nil
	}
	bySeason := map[int]map[int]bool{}
	for k := range nums {
		se, ep := k/1000, k%1000
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
	res, err := s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, separator, title_override, pattern, replacement, subfolder, from_episode, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, want_dub, want_sub)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.ServerID, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub)
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
	_, err := s.DB.Exec(`UPDATE watches SET remote_path = ?, local_path = ?, mode = ?, template = ?, separator = ?, title_override = ?, pattern = ?, replacement = ?, subfolder = ?, from_episode = ?, aired_mapping = ?, rename_provider = ?, rename_ordering = ?, rename_title_lang = ?, rename_series_id = ?, want_dub = ?, want_sub = ?
		WHERE id = ? AND user_id = ?`, in.RemotePath, in.LocalPath, in.Mode, in.Template, in.Separator, in.TitleOverride, in.Pattern, in.Replacement, in.Subfolder, in.FromEpisode, in.AiredMapping, in.RenameProvider, in.RenameOrdering, in.RenameTitleLang, in.RenameSeriesID, in.WantDub, in.WantSub, id, u.ID)
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
