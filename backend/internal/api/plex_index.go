package api

import (
	"log/slog"
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
		slog.Warn("plex index", "err", err)
		return
	}
	s.storePlexRoots(sections) // auto-detect the local mounts Plex reports
	srcOf, animeOf := s.sectionSources(), s.sectionAnime()
	now := time.Now().UTC().Format(time.RFC3339)
	units := 0
	for _, sec := range sections {
		if sec.Type != "show" && sec.Type != "movie" {
			continue
		}
		isMovie := sec.Type == "movie"
		// The library's kind is written into the row here, at index time, which
		// is the only moment it is known for certain. Recovering it later from
		// the folder path cannot work: a copy Plex holds on a disk this
		// instance has no mount for is stored under a pseudo folder and has no
		// path to match a library root against.
		libKind := sectionKind(sec, animeOf[sec.Key], srcOf[sec.Key])
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
			// the same show the catalog knows, reached from the other side: any
			// of Plex's ids leads to the series a match already bundled. 0 until
			// reconcilePlex has attached them, and show_key carries until then.
			seriesID := s.seriesIDForPlexShow(sh, isMovie)
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
				s.storeVariant(0, folder, q, showKey, season, isMovie, seriesID, libKind)
				units++
			}
		}
	}
	db.SetSetting(s.DB, "plex_indexed_at", now)
	slog.Info("plex library indexed", "units", units, "sections", len(sections))
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

// plexRescan asks Plex to scan the directory a file was just moved into, so the
// episode shows up now rather than at the server's next scheduled scan. Best
// effort by design: the move itself already succeeded, and a library Plex does
// not own is a normal outcome, not a failure to report.
func (s *Server) plexRescan(dir string) {
	title := s.plexLibraryOf(dir)
	if title == "" {
		return // not under a known Plex library
	}
	c := s.plexClient()
	if c == nil {
		return
	}
	secs, err := c.Sections()
	if err != nil {
		slog.Debug("plex rescan", "dir", logSafe(dir), "err", err)
		return
	}
	for _, sec := range secs {
		if sec.Title != title {
			continue
		}
		if err := c.Refresh(sec.Key, dir); err != nil {
			slog.Debug("plex rescan", "dir", logSafe(dir), "section", logSafe(sec.Key), "err", err)
			return
		}
		slog.Info("plex rescan", "dir", logSafe(dir), "library", logSafe(title))
		return
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
			// the whole season folder, not just the one episode Plex named: a
			// dub that arrived late sits on the later files, and this is the
			// branch the upgrade cards actually compare against
			if q, ok := s.probeQuality(folder); ok {
				q.Probed = probeMeasured
				return q, folder
			}
		}
	}
	// fallback: Plex's own metadata. Also measured - Plex analyses the media
	// itself and reports the container's tracks, not the file name.
	q := FolderQuality{ResRank: sm.ResHeight, Probed: probeMeasured}
	dub, sub := map[string]bool{}, map[string]bool{}
	// same rule as streamsQuality: a track Plex reports without a readable
	// language is a hole, not an absence. Plex drops a stream that carries no
	// language at all (countsAs), so only its own "und" reaches us - which is
	// the case ffprobe would report the same way.
	for _, l := range sm.Dub {
		dub[langOrUnd(l)] = true
	}
	for _, l := range sm.Sub {
		sub[langOrUnd(l)] = true
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
//
// A stream whose language cannot be read counts as undLang rather than being
// dropped: the track is on the disk, and forgetting it is what let a remote name
// claim a language the local copy already has. Forced subtitle streams are
// dropped upstream in ffprobeFile and never reach here - a forced track is not a
// translation, so it must not leave a hole either.
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
			dub[langOrUnd(st.Lang)] = true
		case "subtitle":
			sub[langOrUnd(st.Lang)] = true
		}
	}
	q.Dub, q.Sub = keysSorted(dub), keysSorted(sub)
	return q
}

// langOrUnd is langCode with the unreadable case named instead of empty.
func langOrUnd(tag string) string {
	if c := langCode(tag); c != "" {
		return c
	}
	return undLang
}

// seriesIDForPlexShow resolves the canonical series behind a Plex show through
// any id Plex reports. Plex's own ratingKey is tried first: reconcilePlex writes
// it, and it is the one id that cannot belong to a different show.
//
// TMDB keeps films and series in two separate id spaces, so the same number is
// two unrelated works. isMovie says which of the two this show is, and that
// namespace is asked first. The other one stays as a LAST resort rather than
// being dropped: attachPlexIdentity files every Plex guid under tmdb:tv to this
// day, films included, so removing it outright would strand the series bundles
// that already exist.
func (s *Server) seriesIDForPlexShow(sh plex.Show, isMovie bool) int64 {
	type ref struct {
		source string
		id     int
	}
	refs := []ref{}
	if rk, err := strconv.Atoi(sh.RatingKey); err == nil && rk > 0 {
		refs = append(refs, ref{"plex", rk})
	}
	if sh.TVDBID != 0 {
		refs = append(refs, ref{"tvdb", sh.TVDBID})
	}
	if sh.TMDBID != 0 {
		if isMovie {
			refs = append(refs, ref{"tmdb:movie", sh.TMDBID}, ref{"tmdb:tv", sh.TMDBID})
		} else {
			refs = append(refs, ref{"tmdb:tv", sh.TMDBID}, ref{"tmdb:movie", sh.TMDBID})
		}
	}
	if sh.IMDBID != 0 {
		refs = append(refs, ref{"imdb", sh.IMDBID})
	}
	for _, r := range refs {
		var id int64
		if s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`,
			r.source, r.id).Scan(&id) == nil && id != 0 {
			return id
		}
	}
	return 0
}
