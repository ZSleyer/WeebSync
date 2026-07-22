package api

import (
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// rawKeyRe matches a canonical show_key used as a title fallback (tvdb:/tmdb:/
// imdb:/fold:) - not something we ever want to display.
var rawKeyRe = regexp.MustCompile(`^(tvdb|tmdb|imdb|fold):`)

// unitTitle picks the best display title for a (show, season) unit: the resolved
// media title when it matched this exact season, otherwise a name derived from
// the remote folder. This avoids showing a raw show_key ("tvdb:294002") and
// avoids reusing one season's title for another (e.g. every Umamusume season
// titled "Season 2" because only that AniList entry was matched).
func unitTitle(rawTitle string, exact bool, folder string) string {
	if (!exact || rawKeyRe.MatchString(rawTitle)) && folder != "" {
		if n := match.GuessTitle(filepath.Base(folder)); n != "" {
			return n
		}
	}
	return rawTitle
}

var plexSeasonDirRe = regexp.MustCompile(`(?i)^season\s+(\d+)$`)

// seasonFolderName builds the Season-folder name for a new season, matching the
// zero-padding a sibling season folder already uses ("Season 03" vs "Season 3");
// defaults to Plex's zero-padded convention.
func seasonFolderName(siblingBase string, season int) string {
	if m := plexSeasonDirRe.FindStringSubmatch(siblingBase); m != nil && len(m[1]) < 2 {
		return fmt.Sprintf("Season %d", season)
	}
	return fmt.Sprintf("Season %02d", season)
}

// episodeTemplate is the rename template for a series season: the season number
// is fixed (files may be absolute-numbered remotely), the episode comes from the
// file. {title} is filled from the title override.
func episodeTemplate(season int) string {
	return fmt.Sprintf("{title} - S%02dE{episode:02}", season)
}

// existingSyncPlan targets the folder a copy ALREADY lives in (an upgrade): the
// existing season dir for a series, the movie's own dir for a movie. Empty when
// the local path is not a shared mount here (a "plex:" fallback key).
func existingSyncPlan(localDir string, season int, isMovie bool) SyncPlan {
	if !strings.HasPrefix(localDir, "/") {
		return SyncPlan{}
	}
	if isMovie {
		return SyncPlan{LocalPath: localDir, Template: "{title}"}
	}
	return SyncPlan{LocalPath: localDir, Template: episodeTemplate(season)}
}

// missingSyncPlan targets a season/movie the library does NOT have yet, using a
// sibling owned copy of the same show to locate where it belongs: a new
// "Season NN" folder under the show root (matching the sibling's padding), or -
// for a movie - its own subfolder under the movie library. siblingDir empty or a
// non-mount path yields an empty plan (UI hides the button).
func missingSyncPlan(siblingDir string, season int, isMovie bool) SyncPlan {
	if !strings.HasPrefix(siblingDir, "/") {
		return SyncPlan{}
	}
	if isMovie {
		// sibling is a movie's own folder; its parent is the movie library root.
		// Give the new movie its OWN subfolder, never another movie's folder.
		return SyncPlan{LocalPath: filepath.Dir(siblingDir), Template: "{title}/{title}"}
	}
	base := filepath.Base(siblingDir)
	showRoot := siblingDir // flat library: the sibling IS the show folder
	if plexSeasonDirRe.MatchString(base) {
		showRoot = filepath.Dir(siblingDir) // sibling is a Season folder → show root is its parent
	}
	return SyncPlan{LocalPath: showRoot, Template: seasonFolderName(base, season) + "/" + episodeTemplate(season)}
}

// UpgradeDims is which quality axes a user wants upgrade suggestions for.
type UpgradeDims struct {
	Res bool `json:"res"`
	Sub bool `json:"sub"`
	Dub bool `json:"dub"`
}

// upgradeDimsFor reads a user's enabled upgrade axes from users.upgrade_dims
// (CSV, default "res,sub,dub"). An empty column means the default was cleared,
// i.e. nothing.
func (s *Server) upgradeDimsFor(userID int64) UpgradeDims {
	var csv string
	s.DB.QueryRow(`SELECT upgrade_dims FROM users WHERE id = ?`, userID).Scan(&csv)
	set := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		set[strings.TrimSpace(p)] = true
	}
	return UpgradeDims{Res: set["res"], Sub: set["sub"], Dub: set["dub"]}
}

// handleUpgradeDimsGet returns the user's upgrade axes.
//
//	@Summary		Get upgrade suggestion axes
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	UpgradeDims
//	@Security		CookieAuth
//	@Router			/api/auth/upgrade-dims [get]
func (s *Server) handleUpgradeDimsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	writeJSON(w, http.StatusOK, s.upgradeDimsFor(u.ID))
}

// handleUpgradeDimsPut stores the user's upgrade axes.
//
//	@Summary		Set upgrade suggestion axes
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			body	body		UpgradeDims	true	"Enabled axes"
//	@Success		200		{object}	OkResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/upgrade-dims [put]
func (s *Server) handleUpgradeDimsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in UpgradeDims
	if !readJSON(w, r, &in) {
		return
	}
	var dims []string
	if in.Res {
		dims = append(dims, "res")
	}
	if in.Sub {
		dims = append(dims, "sub")
	}
	if in.Dub {
		dims = append(dims, "dub")
	}
	s.DB.Exec(`UPDATE users SET upgrade_dims = ? WHERE id = ?`, strings.Join(dims, ","), u.ID)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// SyncPlan is the pre-computed local target for a one-off sync of a suggestion,
// so the "Sync" button drops files into the RIGHT place with the auto-sync
// rename: a series season goes into its Season folder under the show, a movie
// into its OWN subfolder under the movie library (never mixed into another
// movie's folder). LocalPath empty = target could not be resolved (the Plex file
// path is not a shared local mount here), so the UI hides the button.
type SyncPlan struct {
	LocalPath string `json:"localPath"`          // base dir to sync into
	Template  string `json:"template,omitempty"` // rename template (may carry a "Season NN/" or "{title}/" subfolder)
	Subfolder bool   `json:"subfolder"`          // false: the template controls the folder structure
}

// UpgradeVariant is one physical copy of a season/movie and its quality.
type UpgradeVariant struct {
	ServerID   int64    `json:"serverId"`
	ServerName string   `json:"serverName,omitempty"` // "" = local filesystem
	Folder     string   `json:"folder"`
	ResRank    int      `json:"resRank"`
	Dub        []string `json:"dub"`
	Sub        []string `json:"sub"`
}

// UpgradeSuggestion proposes replacing your LOCAL copy (From, the Plex library)
// of ONE (show, season) - or a movie - with a better REMOTE copy that already
// exists (To, the recommended option), naming which axes improve. Options lists
// every remote copy so the UI can show all of them with the best highlighted.
type UpgradeSuggestion struct {
	Key         string           `json:"key"` // dismiss key: unit:{showKey}:{season}
	SeriesID    int64            `json:"seriesId,omitempty"`
	ShowKey     string           `json:"showKey"`
	Season      int              `json:"season"`
	IsMovie     bool             `json:"isMovie,omitempty"`
	Title       string           `json:"title"`
	From        UpgradeVariant   `json:"from"`    // best LOCAL copy
	To          UpgradeVariant   `json:"to"`      // recommended remote copy
	Options     []UpgradeVariant `json:"options"` // all remote copies
	ImprovesRes bool             `json:"improvesRes"`
	ImprovesSub bool             `json:"improvesSub"`
	ImprovesDub bool             `json:"improvesDub"`
	Providers   []string         `json:"providers"`
	Links       ProviderLinks    `json:"links"`
	Cover       string           `json:"cover,omitempty"`
	Format      string           `json:"format,omitempty"` // MOVIE | TV | OVA ...
	Episodes    int              `json:"episodes,omitempty"`
	Category    string           `json:"category"`          // anime-movie | anime-tv | movie | tv, for grouping
	Library     string           `json:"library,omitempty"` // Plex library title (informational)
	Sync        SyncPlan         `json:"sync"`              // where a one-off sync writes (into the existing local season/movie folder)
}

// handleUpgrades lists, per series, every copy that a sibling copy beats on one
// of the user's enabled axes (higher resolution, or a strict superset of the
// sub/dub languages). Read-time over catalog_variants; nothing is stored.
//
//	@Summary		Upgrade suggestions
//	@Description	Better-quality copies (resolution / more sub or dub) of series already present.
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}	UpgradeSuggestion
//	@Security		CookieAuth
//	@Router			/api/upgrades [get]
func (s *Server) handleUpgrades(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	ignored := s.dismissedKeys(u.ID, "upgrade")
	out := []UpgradeSuggestion{}
	for _, up := range s.buildUpgrades(u.ID) {
		if !ignored[up.Key] {
			out = append(out, up)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// buildUpgrades computes a user's upgrade suggestions per canonical unit
// (show_key, season): your LOCAL Plex copy vs the best REMOTE copy of the SAME
// season/movie. No dismiss filter (applied by the caller), no season mixing
// (S1 is never compared to S3), no remote-vs-remote. Shared by /api/upgrades and
// the cached /api/suggestions blob.
func (s *Server) buildUpgrades(userID int64) []UpgradeSuggestion {
	dims := s.upgradeDimsFor(userID)
	units := s.loadUnits()
	enrich := s.unitEnrichIndex()

	out := []UpgradeSuggestion{}
	for _, key := range units.order {
		u := units.byKey[key]
		if len(u.locals) == 0 || len(u.remotes) == 0 {
			continue // not owned locally, or nothing remote to upgrade from
		}
		cur := bestCopy(u.locals)  // your Plex/local copy
		top := bestCopy(u.remotes) // best remote copy of the SAME season
		impRes := dims.Res && top.ResRank > cur.ResRank
		impSub := dims.Sub && strictSuperset(top.Sub, cur.Sub)
		impDub := dims.Dub && strictSuperset(top.Dub, cur.Dub)
		if !impRes && !impSub && !impDub {
			continue
		}
		e := enrich.of(u.showKey, u.season)
		catMedia := anilist.Media{Format: e.format, Genres: e.genres}
		if u.isMovie {
			catMedia.Format = "MOVIE"
		}
		up := UpgradeSuggestion{
			Key: key, SeriesID: e.seriesID, ShowKey: u.showKey, Season: u.season, IsMovie: u.isMovie,
			Title: unitTitle(e.title, e.exact, top.Folder), From: cur, To: top, Options: u.remotes,
			ImprovesRes: impRes, ImprovesSub: impSub, ImprovesDub: impDub,
			Providers: e.providers, Links: e.links,
			Cover: e.cover, Format: e.format, Episodes: e.episodes,
			Category: categorize(e.providers, catMedia, ""),
			Library:  s.plexLibraryOf(cur.Folder),
			Sync:     existingSyncPlan(cur.Folder, u.season, u.isMovie), // sync into the existing local season/movie folder
		}
		out = append(out, up)
	}
	return out
}

// addMissingUnits adds "incomplete" suggestions for canonical units that exist
// REMOTE (server != 0) but NOT in the local Plex library (server 0) - a missing
// season or movie. Each carries all remote copies as candidates so the UI shows
// where to get it and in what quality. Season-precise: a show whose S1-S2 are
// local but S3 is only remote surfaces S3 alone.
func (s *Server) addMissingUnits(acc *sugAcc) {
	units := s.loadUnits()
	enrich := s.unitEnrichIndex()
	// "unvollständig" means a gap in a show you OWN: only surface a missing
	// season/movie when at least one OTHER season of the same show_key is in the
	// local Plex library. A show you own nothing of belongs to trending/watchlist,
	// not here - this also keeps the list from flooding with every unowned remote.
	// remember a real local season/movie dir per show_key, so a missing season's
	// target is a sibling of an owned one (Show/Season NN) and a missing movie
	// lands in its own subfolder under the movie library.
	ownedDir := map[string]string{}
	for _, key := range units.order {
		u := units.byKey[key]
		for _, l := range u.locals {
			if strings.HasPrefix(l.Folder, "/") && ownedDir[u.showKey] == "" {
				ownedDir[u.showKey] = l.Folder
			}
		}
	}
	for _, key := range units.order {
		u := units.byKey[key]
		if len(u.locals) > 0 || len(u.remotes) == 0 || ownedDir[u.showKey] == "" {
			continue // owned this unit already, nothing remote, or show not owned locally
		}
		e := enrich.of(u.showKey, u.season)
		if e.title == "" {
			continue
		}
		cands := make([]plexCandidate, 0, len(u.remotes))
		for _, r := range u.remotes {
			cands = append(cands, plexCandidate{ServerID: r.ServerID, ServerName: r.ServerName, Path: r.Folder})
		}
		title := unitTitle(e.title, e.exact, u.remotes[0].Folder) // season-correct name even if media unresolved
		// carry the full resolved media (cover/episodes/score/format) so the card
		// shows metadata, not just a title
		media := e.media
		media.Format = e.format
		media.Genres = e.genres
		media.Title.Romaji = title
		media.Title.Preferred = title
		acc.add(SugItem{
			RefKey: key, SeriesID: e.seriesID, ShowKey: u.showKey, Season: u.season, IsMovie: u.isMovie,
			Category: categorize(e.providers, media, ""),
			Title:    title, Cover: e.cover, Media: media,
			Providers: e.providers, Links: e.links, Candidates: cands,
			Library: s.plexLibraryOf(ownedDir[u.showKey]),
			Sync:    missingSyncPlan(ownedDir[u.showKey], u.season, u.isMovie),
		})
	}
}

// catUnit is one canonical unit (a show's season, or a movie) with all its
// local (server 0) and remote (server != 0) copies.
type catUnit struct {
	showKey string
	season  int
	isMovie bool
	locals  []UpgradeVariant
	remotes []UpgradeVariant
}

type catUnits struct {
	byKey map[string]*catUnit
	order []string
}

// loadUnits reads every quality variant that carries a canonical unit and groups
// them by (show_key, season) - the SAME key a local and a remote copy of one
// season share, so grouping lines them up. is_movie units are keyed at season 0.
func (s *Server) loadUnits() catUnits {
	names := s.serverNames()
	u := catUnits{byKey: map[string]*catUnit{}}
	rows, err := s.DB.Query(`SELECT server_id, folder, res_rank, dub_codes, sub_codes, show_key, season, is_movie
		FROM catalog_variants WHERE show_key != '' ORDER BY show_key, season`)
	if err != nil {
		return u
	}
	defer rows.Close()
	for rows.Next() {
		var serverID int64
		var folder, dub, sub, showKey string
		var res, season, isMovie int
		if rows.Scan(&serverID, &folder, &res, &dub, &sub, &showKey, &season, &isMovie) != nil {
			continue
		}
		key := unitKey(showKey, season)
		cu := u.byKey[key]
		if cu == nil {
			cu = &catUnit{showKey: showKey, season: season, isMovie: isMovie == 1}
			u.byKey[key] = cu
			u.order = append(u.order, key)
		}
		v := UpgradeVariant{ServerID: serverID, ServerName: names[serverID], Folder: folder,
			ResRank: res, Dub: splitCSV(dub), Sub: splitCSV(sub)}
		if serverID == 0 {
			cu.locals = append(cu.locals, v)
		} else {
			cu.remotes = append(cu.remotes, v)
		}
	}
	return u
}

// unitKey / unitSeasonLabel are the shared dismiss-key and season display helpers.
func unitKey(showKey string, season int) string {
	return "unit:" + showKey + ":" + strconv.Itoa(season)
}

// bestCopy picks the strongest copy: highest resolution, then most dub, then
// most sub languages.
func bestCopy(vs []UpgradeVariant) UpgradeVariant {
	best := vs[0]
	for _, cur := range vs[1:] {
		switch {
		case cur.ResRank != best.ResRank:
			if cur.ResRank > best.ResRank {
				best = cur
			}
		case len(cur.Dub) != len(best.Dub):
			if len(cur.Dub) > len(best.Dub) {
				best = cur
			}
		case len(cur.Sub) > len(best.Sub):
			best = cur
		}
	}
	return best
}

// unitInfo is the display context for a unit, resolved from its show_key.
type unitInfo struct {
	seriesID  int64
	title     string
	cover     string
	format    string
	episodes  int
	genres    []string
	media     anilist.Media // full resolved media, so cards carry episodes/score/etc
	exact     bool          // true when the media matched this exact (show_key, season)
	providers []string
	links     ProviderLinks
}

// unitEnrich maps a show_key (and season) to the provider hits and media behind
// it, so upgrade/incomplete cards carry the same title/cover/badges/links the
// other suggestion cards do. Built once per build from series_provider + the
// Fribb anime mapping (which bridges an AniList id to its tvdb/tmdb show_key).
type unitEnrich struct {
	refsByKey     map[string][]providerRef // show_key -> all provider hits
	seriesByKey   map[string]int64         // show_key -> series id
	mediaBySeason map[string]anilist.Media // "show_key|season" -> per-season media
	srcBySeason   map[string]string        // "show_key|season" -> that media's provider source
	s             *Server
}

func (s *Server) unitEnrichIndex() *unitEnrich {
	e := &unitEnrich{
		refsByKey: map[string][]providerRef{}, seriesByKey: map[string]int64{},
		mediaBySeason: map[string]anilist.Media{}, srcBySeason: map[string]string{}, s: s,
	}
	// Drive off catalog_matches, not series_provider: a variant's show_key is
	// derived straight from its match, so an orphan match (not yet bundled into a
	// series) still resolves a title/cover here. bySrc backfills the series id.
	bySrc, _ := s.seriesProviderMaps()
	rows, err := s.DB.Query(`SELECT DISTINCT source, media_id FROM catalog_matches WHERE media_id != 0`)
	if err != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var source string
		var mediaID int
		if rows.Scan(&source, &mediaID) != nil {
			continue
		}
		seriesID := bySrc[source+"|"+strconv.Itoa(mediaID)]
		showKey, season := "", -1 // -1 = spans all seasons (one id per show)
		var media *anilist.Media
		switch source {
		case "anilist":
			media, _ = s.sourceMedia(source, mediaID)
			a, ok := s.animeIDs(mediaID)
			if !ok {
				continue
			}
			switch {
			case a.tvdbID != 0:
				showKey, season = "tvdb:"+strconv.Itoa(a.tvdbID), unitSeason(a.tvdbSeason, media, "")
			case a.tmdbID != 0 && a.tmdbKind == "movie":
				showKey, season = "tmdb:"+strconv.Itoa(a.tmdbID), 0
			case a.tmdbID != 0:
				showKey, season = "tmdb:"+strconv.Itoa(a.tmdbID), unitSeason(a.tmdbSeason, media, "")
			case a.imdbID != "":
				showKey, season = "imdb:"+a.imdbID, unitSeason(0, media, "")
			}
		case "tmdb:movie":
			showKey, season = "tmdb:"+strconv.Itoa(mediaID), 0
			media, _ = s.sourceMedia(source, mediaID)
		case "tmdb:tv":
			showKey = "tmdb:" + strconv.Itoa(mediaID)
			media, _ = s.sourceMedia(source, mediaID)
		case "tvdb":
			showKey = "tvdb:" + strconv.Itoa(mediaID)
		case "imdb":
			showKey = "imdb:" + strconv.Itoa(mediaID)
		}
		if showKey == "" {
			continue
		}
		e.refsByKey[showKey] = append(e.refsByKey[showKey], providerRef{source, mediaID})
		if seriesID != 0 {
			e.seriesByKey[showKey] = seriesID
		}
		if media != nil {
			e.mediaBySeason[showKey+"|"+strconv.Itoa(season)] = *media
			e.srcBySeason[showKey+"|"+strconv.Itoa(season)] = source
		}
	}
	return e
}

// of resolves the display context for one unit, preferring the season-specific
// media, then the show-wide media, then anything the show_key's providers offer.
func (e *unitEnrich) of(showKey string, season int) unitInfo {
	refs := e.refsByKey[showKey]
	var media *anilist.Media
	var src string
	exact := false
	if m, ok := e.mediaBySeason[showKey+"|"+strconv.Itoa(season)]; ok {
		media, src, exact = &m, e.srcBySeason[showKey+"|"+strconv.Itoa(season)], true // this exact season
	} else if m, ok := e.mediaBySeason[showKey+"|-1"]; ok {
		media, src = &m, e.srcBySeason[showKey+"|-1"]
	} else if m := e.s.seriesMedia(refs); m != nil {
		media = m // source unknown -> treat like AniList (English-first)
	}
	info := unitInfo{seriesID: e.seriesByKey[showKey], exact: exact}
	if media != nil {
		info.title = displayTitle(*media, src)
		info.cover, info.format, info.episodes = media.CoverImage.Large, media.Format, media.Episodes
		info.genres = media.Genres
		info.media = *media
	}
	if info.title == "" {
		info.title = showKey
	}
	info.providers, info.links = e.s.providerBadgesLinks(refs, info.title, showKey)
	return info
}

// serverNames maps server id → display name (id 0 / local has none).
func (s *Server) serverNames() map[int64]string {
	m := map[int64]string{}
	rows, err := s.DB.Query(`SELECT id, name FROM servers`)
	if err != nil {
		return m
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		if rows.Scan(&id, &name) == nil {
			m[id] = name
		}
	}
	return m
}

// seriesMedia resolves cached media for a series from its provider hits,
// preferring AniList (richest metadata), for cover/format/episode display.
func (s *Server) seriesMedia(refs []providerRef) *anilist.Media {
	pick := func(want string) *anilist.Media {
		for _, r := range refs {
			if want == "" || r.Source == want {
				if m, _ := s.sourceMedia(r.Source, r.MediaID); m != nil {
					return m
				}
			}
		}
		return nil
	}
	if m := pick("anilist"); m != nil {
		return m
	}
	return pick("")
}

// strictSuperset reports whether a contains every element of b plus at least one
// more (a ⊋ b).
func strictSuperset(a, b []string) bool {
	if len(a) <= len(b) {
		return false
	}
	for _, x := range b {
		if !slices.Contains(a, x) {
			return false
		}
	}
	return true
}

func splitCSV(s string) []string {
	if s == "" {
		return []string{} // non-nil: marshals as [] not null, so the client can read .length
	}
	return strings.Split(s, ",")
}
