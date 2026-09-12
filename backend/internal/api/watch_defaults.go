package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// watchKinds are the media kinds a default can be set for; the same names
// the calendar filter uses (watchCategory).
var watchKinds = []string{"anime-series", "anime-movie", "series", "movie"}

// subfolderSources name the folder a sync creates below LocalPath: the remote
// folder it came from, or the series title. An empty value is a default stored
// before the choice existed and reads as none/remote via the Subfolder bool.
var subfolderSources = []string{"", "none", "remote", "title"}

// subfolderSeparators are the space replacements a title folder may use. A
// whitelist rather than a sanitizer: the value becomes a path segment, and "/"
// would open a second folder.
var subfolderSeparators = []string{"", " ", "_", ".", "-"}

// KindDefaults is where a new sync of one media kind goes and how its files
// are named.
type KindDefaults struct {
	LocalPath string `json:"localPath"`
	Subfolder bool   `json:"subfolder"` // mirrors SubfolderSource == "remote"
	// SubfolderSource names the subfolder: "remote" after the remote folder,
	// "title" after the series title, "none" for none at all. The title is
	// resolved once, in the dialog that creates the sync, and lands in the
	// watch as part of LocalPath - see aiWatchFields.
	SubfolderSource    string `json:"subfolderSource"`
	SubfolderSeparator string `json:"subfolderSeparator"` // replaces spaces in a title folder; "" keeps them
	Template           string `json:"template"`
	Separator          string `json:"separator"`
}

// CommonDefaults are the rename and language settings every kind shares.
type CommonDefaults struct {
	RenameProvider  string `json:"renameProvider"`  // tvdb | tmdb | ""
	RenameOrdering  string `json:"renameOrdering"`  // official | dvd | absolute | aired | ""
	RenameTitleLang string `json:"renameTitleLang"` // BCP-47 or ""
	AiredMapping    bool   `json:"airedMapping"`
	WantDub         string `json:"wantDub"`
	WantSub         string `json:"wantSub"`
	DubLagDays      int    `json:"dubLagDays"` // see Watch.DubLagDays
	PlexAudioLang   string `json:"plexAudioLang"`
	PlexSubLang     string `json:"plexSubLang"`
}

// WatchDefaults is what a user configured for new auto-syncs: one entry per
// media kind (missing = nothing set for that kind) and the common part.
type WatchDefaults struct {
	Kinds  map[string]KindDefaults `json:"kinds"`
	Common CommonDefaults          `json:"common"`
}

// WatchDefaultsResponse is the defaults, and - when asked for a folder - the
// kind that folder was matched to and the dialog fields with the defaults
// applied.
type WatchDefaultsResponse struct {
	WatchDefaults
	Kind string `json:"kind,omitempty"`
	// Title is the series title of that folder - the catalog match, or the
	// guess from the folder name when it is unmatched. It is what a "title"
	// subfolder is named after.
	Title string `json:"title,omitempty"`
	// Season is the season the folder holds, 0 for a movie or a folder that
	// holds season subfolders itself. SeasonFolder is the folder that season
	// gets ("Season 02", spelled like a sibling when the library has one),
	// LibraryDir the show root the library already holds - the sync goes there
	// rather than to the kind's default folder.
	Season       int            `json:"season,omitempty"`
	SeasonFolder string         `json:"seasonFolder,omitempty"`
	LibraryDir   string         `json:"libraryDir,omitempty"`
	Fields       *aiWatchFields `json:"fields,omitempty"`
}

// watchDefaultsFor reads a user's defaults; an empty or unreadable column is
// no defaults at all.
func (s *Server) watchDefaultsFor(userID int64) WatchDefaults {
	var raw string
	s.DB.QueryRow(`SELECT watch_defaults FROM users WHERE id = ?`, userID).Scan(&raw)
	d := WatchDefaults{Kinds: map[string]KindDefaults{}}
	if raw != "" {
		json.Unmarshal([]byte(raw), &d)
	}
	if d.Kinds == nil {
		d.Kinds = map[string]KindDefaults{}
	}
	// defaults stored before the three-way choice existed carry the bool only
	for kind, k := range d.Kinds {
		if k.SubfolderSource == "" {
			k.SubfolderSource = "none"
			if k.Subfolder {
				k.SubfolderSource = "remote"
			}
			d.Kinds[kind] = k
		}
	}
	return d
}

// folderTarget is what the catalog knows about a remote folder that decides
// where a sync of it belongs: its kind and show title, the season it holds,
// the folder that season gets, and the show root when the library already
// holds another season of the same show.
type folderTarget struct {
	Kind  string
	Title string
	// Season is 0 for a movie, and for a folder that holds season subfolders
	// itself - then the folder is the show, and a season segment under it
	// would nest Season under Season.
	Season int
	// SeasonFolder is "Season 02" by Plex's convention, or spelled like the
	// sibling season the library already has ("Season 2", "Season_02").
	SeasonFolder string
	// LibraryDir is the show root the library holds (an absolute path on a
	// mounted root), "" when the show is not owned or not mounted here.
	LibraryDir string
}

// folderTarget resolves a remote folder: kind and title from the catalog
// match, the season from the same unit the suggestions group by, and the
// library's copy of the show from the same rows the "incomplete" list reads.
func (s *Server) folderTarget(serverID int64, folder string) folderTarget {
	t := folderTarget{}
	t.Kind, t.Title = s.matchedKindTitle(serverID, folder)
	if t.Kind == "" {
		t.Kind = "anime-series"
	}
	showKey, season, isMovie := s.folderUnit(serverID, folder)
	if showKey == "" {
		// unmatched: the folder name is all there is, and a series without a
		// marker is its first season - the same default unitSeason applies
		isMovie = strings.HasSuffix(t.Kind, "movie")
		if season = match.ParseName(path.Base(folder), "", "").Season; season <= 0 && !isMovie {
			season = 1
		}
	}
	if isMovie {
		season = 0
	} else {
		// a folder that names its season is believed over the catalog: a
		// match can land on another season's entry (a "Season 3" folder on
		// the show's first season), and the name is what the user reads
		if n := match.ParseName(path.Base(folder), "", "").Season; n > 0 {
			season = n
		}
		// the show title names the show folder; the per-season title would
		// file "Frieren 2nd Season" beside "Frieren"
		t.Title = match.StripSeason(t.Title, season)
		if s.remoteShowRoot(serverID, folder) {
			season = 0 // the folder is the whole show; its seasons lie inside
		}
	}
	t.Season = season
	if season > 0 {
		t.SeasonFolder = seasonFolderName("", season)
	}
	if showKey == "" {
		return t
	}
	// the library: every local copy of this show, the keys folded the way the
	// suggestions fold them. Any real folder will do, not the best copy: a
	// season can be held as a mounted folder and as a Plex key at once, and
	// the key says where nothing lies.
	if c := s.showKeyCanon()[showScope(showKey, isMovie)]; c != "" {
		showKey = c
	}
	scope := showScope(showKey, isMovie)
	units := s.loadUnits()
	var sibling, same string
	for _, key := range units.order {
		u := units.byKey[key]
		if showScope(u.showKey, u.isMovie) != scope {
			continue
		}
		for _, l := range u.locals {
			if !strings.HasPrefix(l.Folder, "/") {
				continue // a "plex:" key: known to Plex, not mounted here
			}
			if sibling == "" {
				sibling = l.Folder
			}
			if u.season == season && same == "" {
				same = l.Folder
			}
		}
	}
	if sibling == "" {
		return t
	}
	if isMovie {
		// the movie library root; the new film gets its own folder from the
		// title, never another film's folder
		t.LibraryDir = filepath.Dir(sibling)
		return t
	}
	var plan SyncPlan
	if same != "" {
		plan = existingSyncPlan(same, season, false)
	} else {
		plan = missingSyncPlan(sibling, season, false)
	}
	if season > 0 && plexSeasonDirRe.MatchString(filepath.Base(plan.LocalPath)) {
		t.LibraryDir, t.SeasonFolder = filepath.Dir(plan.LocalPath), filepath.Base(plan.LocalPath)
	} else {
		// a flat library keeps the show's files in the show folder itself
		t.LibraryDir, t.SeasonFolder = plan.LocalPath, ""
	}
	return t
}

// seasonInPath reports whether a season folder belongs in the target path. A
// template that carries a "/" lays out the folders itself - an aired-order
// "Season {season:02}/..." - and so does aired mapping, whose season varies
// per file; a Season folder in the path would nest under either.
func seasonInPath(template string, aired bool) bool {
	return !strings.Contains(template, "/") && !aired
}

var seasonPlaceholderRe = regexp.MustCompile(`\{season(?::0?(\d+))?\}`)

// pinSeason writes the season into a template's {season} tokens, keeping each
// token's padding. The rename engine reads the season off the file name and
// falls back to 1 - in a "Season 02" folder that names the files S01E01.
func pinSeason(template string, season int) string {
	return seasonPlaceholderRe.ReplaceAllStringFunc(template, func(tok string) string {
		width := 1
		if m := seasonPlaceholderRe.FindStringSubmatch(tok); m[1] != "" {
			width, _ = strconv.Atoi(m[1])
		}
		return fmt.Sprintf("%0*d", width, season)
	})
}

// apply fills the fields a dialog would otherwise leave blank. The folder
// comes first: the library's own show root when it holds the show, else the
// kind's default folder; then the kind's template and the common part.
// Unknown kinds fall back to the anime series entry.
//
// The subfolder choice is passed on, not resolved: a "title" subfolder is
// named by the dialog, which knows the title the user is looking at and can
// still change it - and appends the season folder it is handed here. What
// reaches a watch is the finished LocalPath.
func (d WatchDefaults) apply(t folderTarget, f *aiWatchFields) {
	kind := t.Kind
	if !slices.Contains(watchKinds, kind) {
		kind = "anime-series"
	}
	k, hasKind := d.Kinds[kind]
	c := d.Common
	if f.Template == "" && hasKind {
		f.Template, f.Separator = k.Template, k.Separator
	}
	inPath := seasonInPath(f.Template, f.AiredMapping || c.AiredMapping)
	switch {
	case f.LocalPath != "":
		// a plan that found the folder keeps it
	case t.LibraryDir != "":
		f.LocalPath, f.Subfolder, f.SubfolderSource = t.LibraryDir, false, "none"
		if inPath && t.SeasonFolder != "" {
			f.LocalPath = path.Join(t.LibraryDir, t.SeasonFolder)
		}
	case hasKind && k.LocalPath != "":
		f.LocalPath, f.Subfolder = k.LocalPath, k.Subfolder
		f.SubfolderSource, f.SubfolderSeparator = k.SubfolderSource, k.SubfolderSeparator
	}
	if inPath && t.Season > 0 {
		f.SeasonFolder = t.SeasonFolder
		f.Template = pinSeason(f.Template, t.Season)
	}
	fill := func(dst *string, v string) {
		if *dst == "" {
			*dst = v
		}
	}
	fill(&f.RenameProvider, c.RenameProvider)
	fill(&f.RenameOrdering, c.RenameOrdering)
	fill(&f.RenameTitleLang, c.RenameTitleLang)
	fill(&f.WantDub, c.WantDub)
	fill(&f.WantSub, c.WantSub)
	if f.DubLagDays == 0 {
		f.DubLagDays = c.DubLagDays
	}
	fill(&f.PlexAudioLang, c.PlexAudioLang)
	fill(&f.PlexSubLang, c.PlexSubLang)
	if c.AiredMapping {
		f.AiredMapping = true
	}
}

// matchedKindTitle returns the media kind a remote or local folder was
// matched to, from the catalog ("" when unmatched), plus the folder's series
// title: the matched media's display title, or the guess from the folder
// name when the catalog has no match. The title is never empty, so a title
// subfolder can be named for an uncatalogued folder too.
func (s *Server) matchedKindTitle(serverID int64, folder string) (kind, title string) {
	source, m := s.aiMatchedMedia(serverID, folder)
	if source == "" {
		return "", match.GuessTitle(path.Base(folder))
	}
	// the record can be missing while the match stands (provider down, cache
	// cold); the source alone still names the kind
	if m != nil {
		title = aiTitle(*m)
	}
	if title == "" {
		title = match.GuessTitle(path.Base(folder))
	}
	return watchCategory(source, m), title
}

// handleWatchDefaultsGet returns the caller's defaults; with serverId and
// path it also resolves the folder's kind and the prefilled dialog fields.
//
//	@Summary		Get auto-sync defaults
//	@Tags			Watches
//	@Produce		json
//	@Param			serverId	query		int		false	"resolve the kind and fields for this folder"
//	@Param			path		query		string	false	"remote folder path"
//	@Success		200			{object}	WatchDefaultsResponse
//	@Security		CookieAuth
//	@Router			/api/auth/watch-defaults [get]
func (s *Server) handleWatchDefaultsGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	out := WatchDefaultsResponse{WatchDefaults: s.watchDefaultsFor(u.ID)}
	if p := r.URL.Query().Get("path"); p != "" {
		serverID, _ := strconv.ParseInt(r.URL.Query().Get("serverId"), 10, 64)
		t := s.folderTarget(serverID, p)
		out.Kind, out.Title, out.Season, out.SeasonFolder, out.LibraryDir = t.Kind, t.Title, t.Season, t.SeasonFolder, t.LibraryDir
		f := &aiWatchFields{RemotePath: p, Mode: "template", MediaSource: "anilist"}
		out.WatchDefaults.apply(t, f)
		out.Fields = f
	}
	writeJSON(w, http.StatusOK, out)
}

var renameProviders = []string{"", "tvdb", "tmdb"}
var renameOrderings = []string{"", "official", "dvd", "absolute", "aired"}

// handleWatchDefaultsPut stores the caller's defaults. Folders must be empty
// or lie under an allowed local root, unknown kinds and option values are
// refused.
//
//	@Summary		Set auto-sync defaults
//	@Tags			Watches
//	@Accept			json
//	@Produce		json
//	@Param			body	body		WatchDefaults	true	"defaults"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/watch-defaults [put]
func (s *Server) handleWatchDefaultsPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in WatchDefaults
	if !readJSON(w, r, &in) {
		return
	}
	clean := WatchDefaults{Kinds: map[string]KindDefaults{}, Common: in.Common}
	for kind, k := range in.Kinds {
		if !slices.Contains(watchKinds, kind) {
			writeErr(w, http.StatusBadRequest, "unknown kind "+kind)
			return
		}
		k.LocalPath = strings.TrimSpace(k.LocalPath)
		if k.LocalPath != "" {
			if _, err := s.safeLocal(k.LocalPath); err != nil {
				writeErr(w, http.StatusBadRequest, kind+": "+err.Error())
				return
			}
		}
		if !slices.Contains(subfolderSources, k.SubfolderSource) {
			writeErr(w, http.StatusBadRequest, kind+": invalid subfolderSource")
			return
		}
		if !slices.Contains(subfolderSeparators, k.SubfolderSeparator) {
			writeErr(w, http.StatusBadRequest, kind+": invalid subfolderSeparator")
			return
		}
		if k.SubfolderSource == "" { // a client that only knows the old bool
			k.SubfolderSource = "none"
			if k.Subfolder {
				k.SubfolderSource = "remote"
			}
		}
		k.Subfolder = k.SubfolderSource == "remote"
		if k.LocalPath == "" && k.Template == "" {
			continue // nothing set for this kind
		}
		clean.Kinds[kind] = k
	}
	if !slices.Contains(renameProviders, clean.Common.RenameProvider) {
		writeErr(w, http.StatusBadRequest, "invalid renameProvider")
		return
	}
	if !slices.Contains(renameOrderings, clean.Common.RenameOrdering) {
		writeErr(w, http.StatusBadRequest, "invalid renameOrdering")
		return
	}
	raw, _ := json.Marshal(clean)
	if _, err := s.DB.Exec(`UPDATE users SET watch_defaults = ? WHERE id = ?`, string(raw), u.ID); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
