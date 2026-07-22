package api

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/plex"
)

// indexPlexLibrary records the quality of the user's LOCAL copies (the Plex
// library) as server-0 catalog variants, keyed by the canonical unit
// (show_key, season) so an upgrade compares "your season 3" against "the remote
// season 3" instead of two whole shows or two remote copies. The show_key comes
// straight from Plex's own tvdb/tmdb/imdb guids - the same shared identity the
// remote side derives (anime via the Fribb mapping, live-action via its
// tmdb/tvdb match) - so no series-bundle resolution is needed to line them up.
//
// Per (show, season) the local quality is read by ffprobe when the Plex file
// path is a shared local mount (accurate), else from Plex's own metadata.
// Runs from the sweep, gated to once an hour (Plex-API heavy).
func (s *Server) indexPlexLibrary() {
	c := s.plexClient()
	if c == nil {
		return
	}
	sections, err := c.Sections()
	if err != nil {
		return
	}
	s.storePlexRoots(sections) // auto-detect the local mounts Plex reports
	now := time.Now().UTC().Format(time.RFC3339)
	for _, sec := range sections {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		isMovie := sec.Type == "movie"
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			// Plex's guids are the shared identity. Fetch detail when the bulk
			// listing carried none (older PMS ignore includeGuids).
			if sh.TVDBID == 0 && sh.TMDBID == 0 && sh.IMDBID == 0 {
				if d, derr := c.ShowDetail(sh.RatingKey); derr == nil {
					sh.TVDBID, sh.TMDBID, sh.IMDBID = d.TVDBID, d.TMDBID, d.IMDBID
				}
			}
			showKey := showKeyFor(sh, sec.Provider)
			if showKey == "" {
				continue // Plex knows no id we can bridge on
			}
			seasons, err := c.SeasonMedia(sh.RatingKey)
			if err != nil || len(seasons) == 0 {
				continue
			}
			for se, sm := range seasons {
				season := se
				if isMovie {
					season = 0
				}
				q, folder := s.plexLocalQuality(sm, sh.RatingKey, season)
				s.DB.Exec(`INSERT OR REPLACE INTO catalog_variants
					(server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie)
					VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)`,
					folder, q.ResRank, strings.Join(q.Dub, ","), strings.Join(q.Sub, ","),
					now, showKey, season, boolInt(isMovie))
			}
		}
	}
	db.SetSetting(s.DB, "plex_indexed_at", now)
}

// storePlexRoots caches, from Plex's reported library locations: the local mounts
// (plex_lib_roots, mapped through any path mapping) merged into localRoots, and a
// root->library-title map (plex_lib_map) used to group suggestions by library.
// Refreshes the transfer allowlist so a sync into the library is permitted.
func (s *Server) storePlexRoots(sections []plex.Section) {
	var roots, mapLines []string
	for _, sec := range sections {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		for _, loc := range sec.Locations {
			local := s.mapPlexPath(strings.TrimRight(strings.TrimSpace(loc), "/"))
			if local == "" {
				continue
			}
			if !slices.Contains(roots, local) {
				roots = append(roots, local)
			}
			mapLines = append(mapLines, local+"\t"+sec.Title)
		}
	}
	db.SetSetting(s.DB, "plex_lib_roots", strings.Join(roots, "\n"))
	db.SetSetting(s.DB, "plex_lib_map", strings.Join(mapLines, "\n"))
	if s.Transfers != nil {
		s.Transfers.Roots = s.localRoots()
	}
}

// plexLibraryOf returns the Plex library title that owns a local folder (longest
// matching library root), or "" when unknown (path not under a known library, or
// not yet detected). Used to group upgrade/incomplete suggestions by library.
func (s *Server) plexLibraryOf(folder string) string {
	if folder == "" || !strings.HasPrefix(folder, "/") {
		return ""
	}
	best := -1
	title := ""
	for _, ln := range splitLines(db.Setting(s.DB, "plex_lib_map")) {
		root, t, ok := strings.Cut(ln, "\t")
		if ok && (folder == root || strings.HasPrefix(folder, root+"/")) && len(root) > best {
			best, title = len(root), t
		}
	}
	return title
}

// RefreshPlexRoots is the exported entry point for wiring at startup.
func (s *Server) RefreshPlexRoots() { s.refreshPlexRoots() }

// refreshPlexRoots re-detects the Plex library mounts on demand (startup, and
// after the Plex connection settings change), independent of the hourly index.
func (s *Server) refreshPlexRoots() {
	c := s.plexClient()
	if c == nil {
		return
	}
	if sections, err := c.Sections(); err == nil {
		s.storePlexRoots(sections)
	}
}

// showKeyFor picks a Plex show's canonical show_key from its guids, preferring
// the provider the library is keyed on so it lines up with how that content's
// remote copy is keyed: anime libraries are tvdb-ordered and their remote is
// bridged to tvdb (Fribb); live-action/movie libraries are tmdb. Falls back to
// the other ids when the preferred one is absent.
func showKeyFor(sh plex.Show, prefer string) string {
	tvdb, tmdb, imdb := "", "", ""
	if sh.TVDBID != 0 {
		tvdb = "tvdb:" + strconv.Itoa(sh.TVDBID)
	}
	if sh.TMDBID != 0 {
		tmdb = "tmdb:" + strconv.Itoa(sh.TMDBID)
	}
	if sh.IMDBID != 0 {
		imdb = "imdb:" + strconv.Itoa(sh.IMDBID)
	}
	order := []string{tvdb, tmdb, imdb}
	if prefer == "tmdb" {
		order = []string{tmdb, tvdb, imdb}
	}
	for _, k := range order {
		if k != "" {
			return k
		}
	}
	return ""
}

// plexLocalQuality resolves a Plex season's local quality and the folder key to
// store it under. When the Plex episode path is a shared local mount that
// actually exists, ffprobe reads the true tracks; otherwise Plex's own
// resolution/languages are used. The folder is the real local directory when
// available (nicer in the UI), else a stable per-season "plex:{ratingKey}:s{N}"
// key (season in the key so distinct seasons don't collide on the variant PK).
func (s *Server) plexLocalQuality(sm plex.ShowMedia, ratingKey string, season int) (FolderQuality, string) {
	folder := "plex:" + ratingKey + ":s" + strconv.Itoa(season)
	// translate the Plex-reported path to where the file is mounted locally
	// (identity for a shared mount; a prefix swap when configured otherwise)
	file := s.mapPlexPath(sm.File)
	if file != "" && underLocalRoot(s.localRoots(), file) {
		if _, err := os.Stat(file); err == nil {
			folder = filepath.Dir(file)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if streams, ok := ffprobeFile(ctx, file); ok {
				return streamsQuality(streams), folder
			}
		}
	}
	// fallback: Plex's own metadata
	q := FolderQuality{ResRank: sm.ResHeight}
	dub, sub := map[string]bool{}, map[string]bool{}
	for _, l := range sm.Dub {
		if c := langCode(l); c != "" {
			dub[c] = true
		}
	}
	for _, l := range sm.Sub {
		if c := langCode(l); c != "" {
			sub[c] = true
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q, folder
}

// underLocalRoot reports whether p sits under one of the configured local roots.
func underLocalRoot(roots []string, p string) bool {
	for _, r := range roots {
		if p == r || strings.HasPrefix(p, strings.TrimRight(r, "/")+"/") {
			return true
		}
	}
	return false
}

// streamsQuality aggregates ffprobe streams into a FolderQuality.
func streamsQuality(streams []probeStream) FolderQuality {
	q := FolderQuality{}
	dub, sub := map[string]bool{}, map[string]bool{}
	for _, st := range streams {
		switch st.CodecType {
		case "video":
			if st.Height > q.ResRank {
				q.ResRank = st.Height
			}
		case "audio":
			if c := langCode(st.Lang); c != "" {
				dub[c] = true
			}
		case "subtitle":
			if c := langCode(st.Lang); c != "" {
				sub[c] = true
			}
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q
}
