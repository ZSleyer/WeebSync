package api

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
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
//
// The season folder is part of the PATH, not of the template. As a template
// prefix it only materialised when renaming was switched on, so a plain sync
// dropped the episodes straight into the show root; and the dialog could not
// name the folder it was about to create.
func missingSyncPlan(siblingDir string, season int, isMovie bool) SyncPlan {
	if !strings.HasPrefix(siblingDir, "/") {
		return SyncPlan{}
	}
	if isMovie {
		// sibling is a movie's own folder; its parent is the movie library root.
		// Give the new movie its OWN subfolder, never another movie's folder.
		// This one stays in the template: the folder is named after {title}, and
		// only the rename engine sanitises a title into a safe path segment.
		return SyncPlan{LocalPath: filepath.Dir(siblingDir), Template: "{title}/{title}"}
	}
	base := filepath.Base(siblingDir)
	showRoot := siblingDir // flat library: the sibling IS the show folder
	if plexSeasonDirRe.MatchString(base) {
		showRoot = filepath.Dir(siblingDir) // sibling is a Season folder → show root is its parent
	}
	return SyncPlan{
		LocalPath: filepath.Join(showRoot, seasonFolderName(base, season)),
		Template:  episodeTemplate(season),
	}
}

// comparable reports whether a copy says anything about its own quality. A row
// with no resolution and no languages carries no information, and comparing
// against it always finds an improvement - which is how a series that is fully
// present, in the right seasons, at 1080p ends up listed as needing an upgrade.
//
// Such rows come from matching a folder in the local catalog: server 0 has no
// file index to read a resolution from, so refreshVariant can only write zeroes.
// The Plex index writes the real per-season rows separately.
func comparable(v UpgradeVariant) bool {
	return v.ResRank > 0 || realLangs(v.Dub) > 0 || realLangs(v.Sub) > 0
}

// realLangs counts the languages a set actually names. undLang is a recorded
// hole, not a language, so it must not make a copy look like it says something
// about itself - nor like it holds one language more than it does.
func realLangs(codes []string) int {
	n := 0
	for _, c := range codes {
		if c != undLang {
			n++
		}
	}
	return n
}

// resTier folds a video height onto the rung it belongs to. The two sides of a
// comparison arrive at their number by different roads - ffprobe reports what
// the container says (1088, a mod-16 padded 1080p; 1072; 800), a remote file
// name states the round marketing figure - and a raw ">" turns that difference
// into an upgrade. Only a real step counts.
func resTier(h int) int {
	switch {
	case h <= 0:
		return 0
	case h < 600:
		return 480
	case h < 900:
		return 720
	case h < 1300:
		return 1080
	case h < 1800:
		return 1440
	case h < 3000:
		return 2160
	default:
		return 4320
	}
}

// improvements decides which axes a remote copy wins, and how far each verdict
// can be trusted.
//
// The language axes are the weak ones, because the two sides used to be
// established by different means: a release named "GerEngSub" claims tracks the
// container need not carry, and it was compared against a local copy whose
// tracks had actually been read. A difference produced that way belongs to the
// methods, not to the files.
//
// This used to be reported anyway and merely marked, because remote copies were
// ALWAYS name-derived and suppressing the mismatch would have switched the
// language axes off for good - including every real "the server has a German dub
// you do not have", the case this app's watch rules are built around. That is no
// longer the trade: a remote copy CAN be measured now (probeRemoteLang reads the
// header over the connection the sync already uses), so the gate costs a wait
// rather than the finding.
//
//   - remote never measured: hold the language gain back. The probe loop will
//     get to it and the card appears on the next build.
//   - remote measured, and impossible to measure: report it. A container that
//     will not answer leaves the name as the best evidence there is, which is
//     what unverified says.
//
// The soft axis needs no such rule: a name can never establish that a subtitle
// is a selectable track, so a copy that was not measured carries an empty Soft
// set and cannot win the axis by accident.
//
// Resolution needs no caveat either: a name and a container mean the same
// picture height, so folding both onto a tier is enough.
func improvements(dims UpgradeDims, cur, top UpgradeVariant, showKey string, season int) (res, sub, dub, soft, unverified, held bool) {
	res = dims.Res && resTier(top.ResRank) > resTier(cur.ResRank)
	if dims.Res && !res && top.ResRank > cur.ResRank {
		slog.Debug("upgrade axis discarded", "showKey", showKey, "season", season,
			"axis", "res", "reason", "both copies are the same resolution tier",
			"fromRes", cur.ResRank, "toRes", top.ResRank)
	}
	sub = dims.Sub && strictSuperset(top.Sub, cur.Sub)
	dub = dims.Dub && strictSuperset(top.Dub, cur.Dub)
	soft = dims.Soft && strictSuperset(top.Soft, cur.Soft)
	if (sub || dub) && top.Probed == probeNone {
		slog.Debug("upgrade language gain held back", "showKey", showKey, "season", season,
			"sub", sub, "dub", dub,
			"reason", "the remote copy has not been measured yet, so the gain is only a claim its name makes",
			"folder", logSafe(top.Folder))
		sub, dub, held = false, false, true
	}
	unverified = (sub || dub) && cur.Probed != top.Probed
	if unverified {
		slog.Debug("upgrade language gain unverified", "showKey", showKey, "season", season,
			"sub", sub, "dub", dub,
			"reason", "one side could not be measured, so its file names are the best evidence there is",
			"localProbed", cur.Probed, "remoteProbed", top.Probed)
	}
	return res, sub, dub, soft, unverified, held
}

// alreadyHave reports whether the library already holds, byte for byte, every
// video file a remote copy offers - the same files under another name.
//
// This is the one signal that survives the asymmetry between the two sides of a
// suggestion. The local quality is MEASURED (ffprobe reads the container), the
// remote quality is GUESSED from file names, and a name that promises more than
// the container carries turns an identical copy into an "upgrade". The file size
// does not care what a release is called.
//
// Compared EXACTLY, no tolerance: that is precisely what makes it usable. An
// equal byte count means an equal file, and a re-encode - the only thing a real
// upgrade can be - never reproduces the source's size, so it always shows up as
// a size the library does not have.
//
// Either side empty means "unknown" (a mount that is not there, a folder the
// crawler has not reached yet), and the caller falls back to the quality
// comparison instead of silently swallowing a suggestion.
func alreadyHave(local, remote map[int64]bool) bool {
	if len(local) == 0 || len(remote) == 0 {
		return false
	}
	for size := range remote {
		if !local[size] {
			return false // brings a file the library does not have
		}
	}
	return true
}

// sizeIndex reads the video-file sizes of the copies a suggestions build looks
// at, and remembers each one: a copy is measured at most once per build, however
// many suggestions ask about it.
type sizeIndex struct {
	s  *Server
	by map[string]map[int64]bool
}

func (s *Server) newSizeIndex() *sizeIndex { return &sizeIndex{s: s, by: map[string]map[int64]bool{}} }

func (x *sizeIndex) of(v UpgradeVariant) map[int64]bool {
	key := strconv.FormatInt(v.ServerID, 10) + "|" + v.Folder
	if sizes, ok := x.by[key]; ok {
		return sizes
	}
	sizes := x.s.copySizes(v.ServerID, v.Folder)
	x.by[key] = sizes
	return sizes
}

// union merges the sizes of several copies - every local copy of one show, so
// "is it already there" can look past the season a unit was filed under.
func (x *sizeIndex) union(vs []UpgradeVariant) map[int64]bool {
	out := map[int64]bool{}
	for _, v := range vs {
		for size := range x.of(v) {
			out[size] = true
		}
	}
	return out
}

// anyAlreadyHave reports whether any of these remote copies is already on disk.
func (x *sizeIndex) anyAlreadyHave(local map[int64]bool, remotes []UpgradeVariant) bool {
	for _, r := range remotes {
		if alreadyHave(local, x.of(r)) {
			return true
		}
	}
	return false
}

// copySizes reads the byte sizes of the video files one copy holds: os.Stat via
// a directory walk for a local copy (server 0), the crawler's remote_index
// snapshot for a remote one.
//
// The remote side deliberately reads the snapshot and never dials the server: a
// suggestions build must not depend on a reachable host, and the index is what
// the crawler already paid for. A folder it has not reached yet returns nothing,
// which alreadyHave reads as "unknown".
func (s *Server) copySizes(serverID int64, folder string) map[int64]bool {
	out := map[int64]bool{}
	if serverID == 0 {
		abs, err := s.safeLocal(folder)
		if err != nil {
			return out // a "plex:..." key, or a path outside the allowed roots
		}
		filepath.WalkDir(abs, func(_ string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !videoExt[strings.ToLower(filepath.Ext(d.Name()))] {
				return nil
			}
			if fi, ferr := d.Info(); ferr == nil && fi.Size() > 0 {
				out[fi.Size()] = true
			}
			return nil
		})
		return out
	}
	rows, err := s.DB.Query(`SELECT name, size FROM remote_index
		WHERE server_id = ? AND is_dir = 0 AND (parent = ? OR parent LIKE ?||'/%')`,
		serverID, folder, folder)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var size int64
		if rows.Scan(&name, &size) != nil {
			continue
		}
		if size > 0 && videoExt[strings.ToLower(filepath.Ext(name))] {
			out[size] = true
		}
	}
	return out
}

// UpgradeDims is which quality axes a user wants upgrade suggestions for.
type UpgradeDims struct {
	Res bool `json:"res"`
	Sub bool `json:"sub"`
	Dub bool `json:"dub"`
	// Soft: the same language, but as a selectable track instead of burned into
	// the picture. Its own axis because it is its own decision - someone who
	// already reads the German signs may not care, and someone who wants to turn
	// them off cares about nothing else.
	Soft bool `json:"soft"`
	// Order lists the enabled axes most important first. It picks the remote
	// copy that gets recommended, sorts the suggestions, and tells the
	// assistant what counts as the better copy.
	Order []string `json:"order"`
}

// upgradeAxes are the axis names in their default priority.
var upgradeAxes = []string{"res", "soft", "sub", "dub"}

// upgradeDimsFor reads a user's upgrade axes from users.upgrade_dims: a CSV
// whose ORDER is the priority (most important first). An empty column means
// the default was cleared, i.e. nothing.
func (s *Server) upgradeDimsFor(userID int64) UpgradeDims {
	var csv string
	s.DB.QueryRow(`SELECT upgrade_dims FROM users WHERE id = ?`, userID).Scan(&csv)
	return dimsFromOrder(strings.Split(csv, ","))
}

// dimsFromOrder builds the axes from an ordered list, dropping unknown names
// and repeats.
func dimsFromOrder(order []string) UpgradeDims {
	d := UpgradeDims{Order: []string{}}
	for _, p := range order {
		p = strings.TrimSpace(p)
		if !slices.Contains(upgradeAxes, p) || slices.Contains(d.Order, p) {
			continue
		}
		d.Order = append(d.Order, p)
		switch p {
		case "res":
			d.Res = true
		case "sub":
			d.Sub = true
		case "dub":
			d.Dub = true
		case "soft":
			d.Soft = true
		}
	}
	return d
}

// axisRank is the priority index of an axis, len(order) when disabled.
func axisRank(order []string, axis string) int {
	if i := slices.Index(order, axis); i >= 0 {
		return i
	}
	return len(order)
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
	enabled := map[string]bool{"res": in.Res, "sub": in.Sub, "dub": in.Dub, "soft": in.Soft}
	// the given order first (only enabled axes), then whatever is enabled but
	// unordered, in the default priority
	var order []string
	for _, a := range in.Order {
		if enabled[a] {
			order = append(order, a)
		}
	}
	for _, a := range upgradeAxes {
		if enabled[a] {
			order = append(order, a)
		}
	}
	d := dimsFromOrder(order)
	s.DB.Exec(`UPDATE users SET upgrade_dims = ? WHERE id = ?`, strings.Join(d.Order, ","), u.ID)
	// the cached suggestions were ranked under the old axes: drop them and
	// rebuild now, so the page does not show the old order for half an hour
	key := fmt.Sprintf("suggestions:%d", u.ID)
	s.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`, key)
	uid := u.ID
	s.runJob(key, func(ctx context.Context) { s.buildUserSuggestions(ctx, uid) })
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
	// Soft is the subset of Sub the copy can hand over as a selectable track
	// (subtitle stream or sidecar file). A language in Sub but not in Soft is
	// burned into the picture, and the card says so.
	Soft []string `json:"soft"`
	// Probed: how the languages above were established - 0 nothing measured yet,
	// 1 read from the container streams, 2 measuring was attempted and the
	// container would not answer. The card shows this so a disputed suggestion
	// can be judged without reading the log.
	Probed probeState `json:"probed"`
}

// LocalSeason is one season - or the movie - of the same show the library
// ALREADY holds, so a card can show what is there beside what it proposes.
type LocalSeason struct {
	Season  int    `json:"season"`
	Folder  string `json:"folder"` // local dir, or a "plex:" key when it is not a shared mount
	ResRank int    `json:"resRank"`
	IsMovie bool   `json:"isMovie,omitempty"`
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
	// ImprovesSoft: the remote copy offers a subtitle language as a SELECTABLE
	// track that the local one only shows burned into the picture.
	ImprovesSoft bool `json:"improvesSoft"`
	// LanguageUnverified: the sub/dub gain above rests on one side's file names
	// because its container would not answer, so it cannot be confirmed from
	// here - the local copy may already carry the track without a language tag.
	// The finding stands, the card says it is unconfirmed.
	LanguageUnverified bool          `json:"languageUnverified,omitempty"`
	Providers          []string      `json:"providers"`
	Links              ProviderLinks `json:"links"`
	Cover              string        `json:"cover,omitempty"`
	Format             string        `json:"format,omitempty"` // MOVIE | TV | OVA ...
	Episodes           int           `json:"episodes,omitempty"`
	Category           string        `json:"category"`          // anime-movie | anime-tv | movie | tv, for grouping
	Library            string        `json:"library,omitempty"` // Plex library title (informational)
	Sync               SyncPlan      `json:"sync"`              // where a one-off sync writes (into the existing local season/movie folder)
	// every season of this show the library already has, this one included
	LocalSeasons []LocalSeason `json:"localSeasons,omitempty"`
}

// handleUpgrades lists, per series, every copy that a sibling copy beats on one
// of the user's enabled axes (a higher resolution tier, or a strict superset of
// the sub/dub languages - flagged languageUnverified when the two sides were
// established differently). Read-time over catalog_variants; nothing is stored.
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
	localsByShow := localSeasonsByShow(units)
	sizes := s.newSizeIndex()

	out := []UpgradeSuggestion{}
	for _, key := range units.order {
		u := units.byKey[key]
		if len(u.locals) == 0 || len(u.remotes) == 0 {
			continue // not owned locally, or nothing remote to upgrade from
		}
		cur := bestCopy(u.locals)                 // your Plex/local copy
		top := bestCopyFor(dims.Order, u.remotes) // the remote copy the user's priorities prefer
		if !comparable(cur) {
			// nothing is known about this copy, so every remote one "improves"
			// it: 1080 beats 0, and any language set is a superset of none.
			// That is not an upgrade, it is a blind spot.
			slog.Debug("upgrade skipped", "showKey", u.showKey, "season", u.season,
				"folder", logSafe(cur.Folder), "reason", "local copy has no quality to compare against")
			continue
		}
		impRes, impSub, impDub, impSoft, langUnverified, held := improvements(dims, cur, top, u.showKey, u.season)
		if held {
			// somebody is looking at this unit right now, so the copy behind it
			// jumps the queue instead of waiting for the background pace
			s.wantProbe(top.ServerID, top.Folder)
		}
		if !impRes && !impSub && !impDub && !impSoft {
			continue
		}
		// The names say "better" - but is it another file at all? Sizes settle
		// it. Deliberately AFTER the quality gate and not before: only a copy
		// that is about to be recommended pays for the walk, so the check costs
		// one directory listing per suggestion instead of one per owned season.
		if alreadyHave(sizes.union(u.locals), sizes.of(top)) {
			slog.Debug("upgrade skipped", "showKey", u.showKey, "season", u.season,
				"folder", logSafe(top.Folder), "reason", "remote copy holds the same files, only named differently")
			continue
		}
		e := enrich.of(u.showKey, u.season, u.isMovie)
		catMedia := anilist.Media{Format: e.format, Genres: e.genres}
		if u.isMovie {
			catMedia.Format = "MOVIE"
		}
		// The series decides its own kind once the sweep has looked at it; the
		// library's kind only fills in until then, so an anime library's cards
		// sit in the anime block instead of next to the live-action ones. It is
		// a fallback and never a veto - local and remote are the SAME work here
		// (they met on show_key and season), so a kind disagreement means one
		// derivation is wrong, not that the pairing is.
		kind := e.kind
		if kind == "" {
			kind = u.libKind
		}
		// the local folder names the library; a copy Plex holds on an unmounted
		// disk has no path to name it with, so a sibling season stands in
		lib := s.plexLibraryOf(cur.Folder)
		if lib == "" {
			for _, l := range localsByShow[showScope(u.showKey, u.isMovie)] {
				if lib = s.plexLibraryOf(l.Folder); lib != "" {
					break
				}
			}
		}
		up := UpgradeSuggestion{
			Key: key, SeriesID: e.seriesID, ShowKey: u.showKey, Season: u.season, IsMovie: u.isMovie,
			Title: unitTitle(e.title, e.exact, top.Folder), From: cur, To: top, Options: u.remotes,
			ImprovesRes: impRes, ImprovesSub: impSub, ImprovesDub: impDub, ImprovesSoft: impSoft,
			LanguageUnverified: langUnverified,
			Providers:          e.providers, Links: e.links,
			Cover: e.cover, Format: e.format, Episodes: e.episodes,
			Category: categorize(e.providers, catMedia, "", kind),
			Library:  lib,
			Sync:     existingSyncPlan(cur.Folder, u.season, u.isMovie), // sync into the existing local season/movie folder

			LocalSeasons: localsByShow[showScope(u.showKey, u.isMovie)],
		}
		// a better remote copy exists for a season you own: which axis wins
		slog.Debug("upgrade found", "showKey", u.showKey, "season", u.season,
			"res", impRes, "sub", impSub, "dub", impDub, "soft", impSoft, "langUnverified", langUnverified,
			"fromRes", cur.ResRank, "toRes", top.ResRank,
			"localProbed", cur.Probed, "remoteProbed", top.Probed)
		out = append(out, up)
	}
	if len(out) > 0 {
		slog.Debug("upgrades built", "user", userID, "suggestions", len(out))
	}
	// the axis the user ranks highest decides the order: a suggestion that
	// improves it comes before one that only improves a lower axis
	rank := func(up UpgradeSuggestion) int {
		best := len(dims.Order)
		for axis, imp := range map[string]bool{"res": up.ImprovesRes, "soft": up.ImprovesSoft, "sub": up.ImprovesSub, "dub": up.ImprovesDub} {
			if imp {
				best = min(best, axisRank(dims.Order, axis))
			}
		}
		return best
	}
	slices.SortStableFunc(out, func(a, b UpgradeSuggestion) int {
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra - rb
		}
		return strings.Compare(a.Title, b.Title)
	})
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
	//
	// Ownership is asked PER FORM (showScope). Owning the series tmdb:550 says
	// nothing about the film tmdb:550, which is a different work under a
	// show_key that happens to spell the same - and answering with the series'
	// folder is how a film ended up listed as a missing part of a show, with a
	// sync plan pointing into the series library.
	ownedDir := map[string]string{}
	ownedKind := map[string]string{}
	localsOfShow := map[string][]UpgradeVariant{}
	for _, key := range units.order {
		u := units.byKey[key]
		sc := showScope(u.showKey, u.isMovie)
		localsOfShow[sc] = append(localsOfShow[sc], u.locals...)
		if len(u.locals) > 0 && ownedKind[sc] == "" {
			ownedKind[sc] = u.libKind
		}
		for _, l := range u.locals {
			if strings.HasPrefix(l.Folder, "/") && ownedDir[sc] == "" {
				ownedDir[sc] = l.Folder
			}
		}
	}
	// what the show's local copies actually hold, read once per show and only
	// for a show that is about to be called incomplete
	sizes := s.newSizeIndex()
	onDisk := map[string]map[int64]bool{}
	sizesOfShow := func(scope string) map[int64]bool {
		if v, ok := onDisk[scope]; ok {
			return v
		}
		v := sizes.union(localsOfShow[scope])
		onDisk[scope] = v
		return v
	}
	for _, key := range units.order {
		u := units.byKey[key]
		sc := showScope(u.showKey, u.isMovie)
		if len(u.locals) > 0 || len(u.remotes) == 0 || ownedDir[sc] == "" {
			continue // owned this unit already, nothing remote, or show not owned locally
		}
		e := enrich.of(u.showKey, u.season, u.isMovie)
		if e.title == "" {
			continue
		}
		// a season whose files are already on disk is not missing, whatever
		// season the mapping filed it under: the local copies of THIS SHOW are
		// searched, not just the ones that landed on this unit's season number.
		// That is exactly the case a wrong season mapping produces.
		if sizes.anyAlreadyHave(sizesOfShow(sc), u.remotes) {
			slog.Debug("incomplete skipped", "showKey", u.showKey, "season", u.season,
				"reason", "the library already holds these files under another season")
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
		// the unit that is MISSING has no local copy of its own, so the kind
		// fallback comes from the sibling that made the show count as owned
		kind := e.kind
		if kind == "" {
			kind = ownedKind[sc]
		}
		acc.add(SugItem{
			RefKey: key, SeriesID: e.seriesID, ShowKey: u.showKey, Season: u.season, IsMovie: u.isMovie,
			Category: categorize(e.providers, media, "", kind),
			Title:    title, Cover: e.cover, Media: media,
			Providers: e.providers, Links: e.links, Candidates: cands,
			Library: s.plexLibraryOf(ownedDir[sc]),
			Sync:    missingSyncPlan(ownedDir[sc], u.season, u.isMovie),
		})
	}
}

// catUnit is one canonical unit (a show's season, or a movie) with all its
// local (server 0) and remote (server != 0) copies.
type catUnit struct {
	showKey string
	season  int
	isMovie bool
	// libKind: the kind of the Plex library the LOCAL copies came from
	// (kindAnime or ""). Only server-0 rows carry one; it decorates, it never
	// decides - see the note on categorize in buildUpgrades.
	libKind string
	locals  []UpgradeVariant
	remotes []UpgradeVariant
}

type catUnits struct {
	byKey map[string]*catUnit
	order []string
}

// localSeasonsByShow collapses the units into "what does the library already
// hold for this show": the best local copy per season, in season order
// (units.order is ORDER BY show_key, season). Pure memory - the suggestions
// build runs in the background and gets cached, so a card decoration must not
// send it walking the filesystem.
func localSeasonsByShow(units catUnits) map[string][]LocalSeason {
	out := map[string][]LocalSeason{}
	for _, key := range units.order {
		u := units.byKey[key]
		if len(u.locals) == 0 {
			continue
		}
		b := bestCopy(u.locals)
		out[showScope(u.showKey, u.isMovie)] = append(out[showScope(u.showKey, u.isMovie)], LocalSeason{
			Season: u.season, Folder: b.Folder, ResRank: b.ResRank, IsMovie: u.isMovie,
		})
	}
	return out
}

// loadUnits reads every quality variant that carries a canonical unit and groups
// them by (show_key, season, is_movie) - the SAME key a local and a remote copy
// of one season share, so grouping lines them up. is_movie units are keyed at
// season 0.
//
// The form belongs in the key. Without it a film and a season met in one unit
// and were treated as copies of each other, because season 0 is where BOTH a
// film and several kinds of season land: a Plex specials season (parent index
// 0), a tv folder whose name carries no season marker, and TMDB, whose film and
// series ids are separate spaces that the show_key spells the same way. Whoever
// created the bucket decided its form and every other row's is_movie was
// dropped, so a series could be offered a film as "the better copy" of itself.
func (s *Server) loadUnits() catUnits {
	names := s.serverNames()
	canon := s.showKeyCanon()
	u := catUnits{byKey: map[string]*catUnit{}}
	rows, err := s.DB.Query(`SELECT server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, show_key, season, is_movie, probed, lib_kind
		FROM catalog_variants WHERE show_key != '' ORDER BY show_key, season`)
	if err != nil {
		return u
	}
	defer rows.Close()
	for rows.Next() {
		var serverID int64
		var folder, dub, sub, soft, showKey, libKind string
		var res, season, isMovie, probed int
		if rows.Scan(&serverID, &folder, &res, &dub, &sub, &soft, &showKey, &season, &isMovie, &probed, &libKind) != nil {
			continue
		}
		movie := isMovie == 1
		if c := canon[showScope(showKey, movie)]; c != "" {
			showKey = c
		}
		key := unitKey(showKey, season, movie)
		cu := u.byKey[key]
		if cu == nil {
			cu = &catUnit{showKey: showKey, season: season, isMovie: movie}
			u.byKey[key] = cu
			u.order = append(u.order, key)
		}
		if libKind != "" && cu.libKind == "" {
			cu.libKind = libKind
		}
		v := UpgradeVariant{ServerID: serverID, ServerName: names[serverID], Folder: folder,
			ResRank: res, Dub: splitCSV(dub), Sub: splitCSV(sub), Soft: splitCSV(soft), Probed: probeState(probed)}
		if serverID == 0 {
			cu.locals = append(cu.locals, v)
		} else {
			cu.remotes = append(cu.remotes, v)
		}
	}
	return u
}

// unitKey / unitSeasonLabel are the shared dismiss-key and season display helpers.
// A film carries the ":m" suffix: the key is also the React key and the radio
// group name of the card, and a film and a season-0 series sharing one string
// makes picking a version in one card clear the other's selection.
func unitKey(showKey string, season int, isMovie bool) string {
	k := "unit:" + showKey + ":" + strconv.Itoa(season)
	if isMovie {
		k += ":m"
	}
	return k
}

// showScope names one show IN ONE FORM. Everything that asks "what does the
// library already hold for this show" has to ask it per form, or owning a
// series makes an unrelated film of the same id a missing part of it.
func showScope(showKey string, isMovie bool) string {
	if isMovie {
		return showKey + "|m"
	}
	return showKey
}

// showKeyCanon maps every show_key onto the one that stands for its series, so
// two spellings of the same show group as one. Both are real ids: Plex names
// JoJo tvdb:262954, the Fribb mapping files the 1993 OVA as tvdb:83950, and a
// show the mapping has no tvdb id for gets a tmdb: or fold: key that lines up
// with neither. The series knows they belong together; this is where the
// copies find that out.
//
// ponytail: grouping stays on show_key rather than moving to series_id, which
// would need every copy to carry one - the Plex-indexed local rows do not, and
// a copy without a series would stop meeting its remote counterpart. Folding
// the keys gets the same shows together without that dependency.
func (s *Server) showKeyCanon() map[string]string {
	rows, err := s.DB.Query(`SELECT DISTINCT show_key, series_id, is_movie FROM catalog_variants
		WHERE series_id != 0 AND show_key != '' ORDER BY show_key`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	stands := map[string]string{} // (series, form) -> the show_key that speaks for it
	canon := map[string]string{}  // showScope(key, form) -> that key
	for rows.Next() {
		var showKey string
		var seriesID int64
		var isMovie int
		if rows.Scan(&showKey, &seriesID, &isMovie) != nil {
			continue
		}
		// A series bundles a show with its films, so folding by series alone
		// hands every season of the show the film's key - and both sides are
		// then the same unit again, one layer above the one loadUnits guards.
		// Fold per (series, form), and key the result per form too: a single
		// show_key can appear under both (TMDB spells a film id and a series id
		// the same way), and a bare-key map would rewrite it to whichever form
		// was read last.
		form := strconv.Itoa(isMovie)
		if first, ok := stands[strconv.FormatInt(seriesID, 10)+"|"+form]; ok {
			if first != showKey {
				canon[showScope(showKey, isMovie == 1)] = first
			}
			continue
		}
		stands[strconv.FormatInt(seriesID, 10)+"|"+form] = showKey
	}
	return canon
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
		case realLangs(cur.Dub) != realLangs(best.Dub):
			if realLangs(cur.Dub) > realLangs(best.Dub) {
				best = cur
			}
		case realLangs(cur.Sub) != realLangs(best.Sub):
			if realLangs(cur.Sub) > realLangs(best.Sub) {
				best = cur
			}
		case realLangs(cur.Soft) > realLangs(best.Soft):
			// same languages on both, but one of them can be switched off
			best = cur
		}
	}
	return best
}

// bestCopyFor picks the copy the user would want by their axis priority: the
// first axis in order on which two copies differ decides (resolution by tier,
// languages by count). Copies equal on every enabled axis fall back to
// bestCopy's fixed order.
func bestCopyFor(order []string, copies []UpgradeVariant) UpgradeVariant {
	if len(copies) == 0 {
		return UpgradeVariant{}
	}
	best := copies[0]
	for _, c := range copies[1:] {
		if betterBy(order, c, best) {
			best = c
		}
	}
	return best
}

// betterBy reports whether a beats b under the axis priority.
func betterBy(order []string, a, b UpgradeVariant) bool {
	for _, axis := range order {
		var d int
		switch axis {
		case "res":
			d = resTier(a.ResRank) - resTier(b.ResRank)
		case "soft":
			d = realLangs(a.Soft) - realLangs(b.Soft)
		case "sub":
			d = realLangs(a.Sub) - realLangs(b.Sub)
		case "dub":
			d = realLangs(a.Dub) - realLangs(b.Dub)
		}
		if d != 0 {
			return d > 0
		}
	}
	// a tie on every axis the user cares about: the fixed order decides, and
	// it keeps the first copy on a full tie
	w := bestCopy([]UpgradeVariant{b, a})
	return w.ServerID == a.ServerID && w.Folder == a.Folder && (w.ServerID != b.ServerID || w.Folder != b.Folder)
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
	kind      string        // anime | live_action | "" (undecided), from the series row
	providers []string
	links     ProviderLinks
}

// unitEnrich maps a show_key (and season) to the provider hits and media behind
// it, so upgrade/incomplete cards carry the same title/cover/badges/links the
// other suggestion cards do. Built once per build from series_provider + the
// Fribb anime mapping (which bridges an AniList id to its tvdb/tmdb show_key).
type unitEnrich struct {
	refsByKey     map[string][]providerRef // show_key -> all provider hits
	seriesByKey   map[string]int64
	kindByKey     map[string]string        // show_key -> anime | live_action
	mediaBySeason map[string]anilist.Media // "show_key|season" -> per-season media
	srcBySeason   map[string]string        // "show_key|season" -> that media's provider source
	s             *Server
}

func (s *Server) unitEnrichIndex() *unitEnrich {
	e := &unitEnrich{
		refsByKey: map[string][]providerRef{}, seriesByKey: map[string]int64{}, kindByKey: map[string]string{},
		mediaBySeason: map[string]anilist.Media{}, srcBySeason: map[string]string{}, s: s,
	}
	// Drive off catalog_matches, not series_provider: a variant's show_key is
	// derived straight from its match, so an orphan match (not yet bundled into a
	// series) still resolves a title/cover here. bySrc backfills the series id.
	bySrc, _ := s.seriesProviderMaps()
	kinds := s.seriesKinds()
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
		movie := false
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
				showKey, movie = "tmdb:"+strconv.Itoa(a.tmdbID), true
			case a.tmdbID != 0:
				showKey, season = "tmdb:"+strconv.Itoa(a.tmdbID), unitSeason(a.tmdbSeason, media, "")
			case a.imdbID != "":
				showKey, season = "imdb:"+a.imdbID, unitSeason(0, media, "")
			}
		case "tmdb:movie":
			showKey, movie = "tmdb:"+strconv.Itoa(mediaID), true
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
			if k := kinds[seriesID]; k != "" {
				e.kindByKey[showKey] = k
			}
		}
		if media != nil {
			e.mediaBySeason[showKey+enrichSlot(season, movie)] = *media
			e.srcBySeason[showKey+enrichSlot(season, movie)] = source
		}
	}
	return e
}

// enrichSlot names the media shelf a provider hit goes on. A film gets its own
// shelf rather than season 0: films used to be filed there, which is also where
// a specials season and a season-less tv folder land, so a season could be
// decorated with a film's title, cover and Format=MOVIE and then be sorted into
// the films block.
func enrichSlot(season int, isMovie bool) string {
	if isMovie {
		return "|m"
	}
	return "|" + strconv.Itoa(season)
}

// of resolves the display context for one unit, preferring the season-specific
// media, then the show-wide media, then anything the show_key's providers offer.
// A film only ever reads the film shelf and a season never does.
//
// ponytail: refsByKey stays keyed by show_key alone, so a film and a series that
// collide on one TMDB number still pool their provider badges. Splitting the
// tmdb: prefix per namespace would fix that and drag plexRatingKeyFor,
// attachPlexIdentity and four test files along; a stray badge is the price.
func (e *unitEnrich) of(showKey string, season int, isMovie bool) unitInfo {
	refs := e.refsByKey[showKey]
	var media *anilist.Media
	var src string
	exact := false
	slot := enrichSlot(season, isMovie)
	if m, ok := e.mediaBySeason[showKey+slot]; ok {
		media, src, exact = &m, e.srcBySeason[showKey+slot], true // this exact season
	} else if m, ok := e.mediaBySeason[showKey+"|-1"]; ok && !isMovie {
		media, src = &m, e.srcBySeason[showKey+"|-1"]
	} else if m := e.s.seriesMedia(refs); m != nil {
		media = m // source unknown -> treat like AniList (English-first)
	}
	info := unitInfo{seriesID: e.seriesByKey[showKey], kind: e.kindByKey[showKey], exact: exact}
	if media != nil {
		info.title = displayTitle(*media, src)
		info.cover, info.format, info.episodes = media.CoverImage.Large, media.Format, media.Episodes
		info.genres = media.Genres
		info.media = *media
	}
	// belt and braces on top of the shelf split: a season that fell back to a
	// show-wide or series-wide media must not inherit a MOVIE format from it,
	// or categorize files the season under the films.
	if !isMovie && !exact && info.format == "MOVIE" {
		info.format = ""
		info.media.Format = ""
	}
	// a stored multi-locale title (series_titles, de→en→x-jat) beats a
	// show-wide/mismatched media title or a folder-derived guess; an exact
	// per-season media title stays - it may carry the season's own name.
	if !exact {
		if t := e.s.seriesLocalTitle(info.seriesID); t != "" {
			info.title = t
			info.exact = true // callers must not replace it with a folder guess
		}
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
