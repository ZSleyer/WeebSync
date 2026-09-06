package api

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// watchKinds are the media kinds a default can be set for; the same names
// the calendar filter uses (watchCategory).
var watchKinds = []string{"anime-series", "anime-movie", "series", "movie"}

// KindDefaults is where a new sync of one media kind goes and how its files
// are named.
type KindDefaults struct {
	LocalPath string `json:"localPath"`
	Subfolder bool   `json:"subfolder"`
	Template  string `json:"template"`
	Separator string `json:"separator"`
}

// CommonDefaults are the rename and language settings every kind shares.
type CommonDefaults struct {
	RenameProvider  string `json:"renameProvider"`  // tvdb | tmdb | ""
	RenameOrdering  string `json:"renameOrdering"`  // official | dvd | absolute | aired | ""
	RenameTitleLang string `json:"renameTitleLang"` // BCP-47 or ""
	AiredMapping    bool   `json:"airedMapping"`
	WantDub         string `json:"wantDub"`
	WantSub         string `json:"wantSub"`
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
	Kind   string         `json:"kind,omitempty"`
	Fields *aiWatchFields `json:"fields,omitempty"`
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
	return d
}

// apply fills the fields a dialog would otherwise leave blank: the kind's
// folder and template (only when no folder was chosen yet, so a plan that
// found the existing library folder keeps it), then the common part. Unknown
// kinds fall back to the anime series entry.
func (d WatchDefaults) apply(kind string, f *aiWatchFields) {
	if !slices.Contains(watchKinds, kind) {
		kind = "anime-series"
	}
	if k, ok := d.Kinds[kind]; ok && f.LocalPath == "" && k.LocalPath != "" {
		f.LocalPath, f.Subfolder = k.LocalPath, k.Subfolder
		if f.Template == "" {
			f.Template, f.Separator = k.Template, k.Separator
		}
	}
	c := d.Common
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
	fill(&f.PlexAudioLang, c.PlexAudioLang)
	fill(&f.PlexSubLang, c.PlexSubLang)
	if c.AiredMapping {
		f.AiredMapping = true
	}
}

// matchedKind is the media kind a remote or local folder was matched to, from
// the catalog; "" when it is unmatched.
func (s *Server) matchedKind(serverID int64, folder string) string {
	source, m := s.aiMatchedMedia(serverID, folder)
	if source == "" {
		return ""
	}
	return watchCategory(source, m)
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
		out.Kind = s.matchedKind(serverID, p)
		if out.Kind == "" {
			out.Kind = "anime-series"
		}
		f := &aiWatchFields{RemotePath: p, Mode: "template", MediaSource: "anilist"}
		out.WatchDefaults.apply(out.Kind, f)
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
