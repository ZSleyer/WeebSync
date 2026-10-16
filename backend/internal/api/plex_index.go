package api

import (
	"context"
	"log/slog"
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
func (s *Server) indexPlexLibrary(ctx context.Context) {
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
		// a stopped index leaves what it already measured in place: every unit
		// is stored on its own and the probe cache keeps the work, so the next
		// sweep carries on rather than starting over. Only the stamp is skipped.
		if ctx.Err() != nil {
			slog.Info("plex index stopped", "units", units)
			return
		}
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
			if ctx.Err() != nil {
				slog.Info("plex index stopped", "units", units)
				return
			}
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
// root->library-title map (plex_lib_map) used to group suggestions by library,
// and a root->match-scope map (plex_lib_scopes) so an auto-sync writing into a
// library is matched against the source chosen for it. Refreshes the transfer allowlist so a sync into the library is permitted.
func (s *Server) storePlexRoots(sections []plex.Section) {
	var roots, mapLines, scopeLines []string
	srcOf := s.sectionSources()
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
			scopeLines = append(scopeLines, local+"\t"+libraryScope(sec, srcOf[sec.Key]))
		}
	}
	before := db.Setting(s.DB, "plex_lib_scopes")
	db.SetSetting(s.DB, "plex_lib_roots", strings.Join(roots, "\n"))
	db.SetSetting(s.DB, "plex_lib_map", strings.Join(mapLines, "\n"))
	db.SetSetting(s.DB, "plex_lib_scopes", strings.Join(scopeLines, "\n"))
	if s.Transfers != nil {
		s.Transfers.Roots = s.localRoots()
	}
	if changed := changedRoots(before, scopeLines); len(changed) > 0 {
		s.rematchLibraryWatches(changed)
	}
}

// changedRoots lists the library roots whose match scope differs from the
// "root\tscope" lines stored before. A root seen for the first time counts:
// its watches were matched without any library at all.
func changedRoots(before string, after []string) []string {
	old := map[string]string{}
	for _, ln := range splitLines(before) {
		if root, v, ok := strings.Cut(ln, "\t"); ok {
			old[root] = v
		}
	}
	var out []string
	for _, ln := range after {
		if root, v, ok := strings.Cut(ln, "\t"); ok && old[root] != v {
			out = append(out, root)
		}
	}
	return out
}

// rematchLibraryWatches sends the watches writing into these library roots
// through the matcher again, manual matches included: the library's source
// was just changed, and a match from the old one is what the change was for.
func (s *Server) rematchLibraryWatches(roots []string) {
	rows, err := s.DB.Query(`SELECT server_id, remote_path, local_path FROM watches`)
	if err != nil {
		return
	}
	type watchFolder struct {
		serverID      int64
		remote, local string
	}
	var all []watchFolder
	for rows.Next() {
		var w watchFolder
		if rows.Scan(&w.serverID, &w.remote, &w.local) == nil {
			all = append(all, w)
		}
	}
	rows.Close()
	queued := 0
	for _, w := range all {
		target := s.localAbs(w.local)
		if !slices.ContainsFunc(roots, func(r string) bool { return target == r || strings.HasPrefix(target, r+"/") }) {
			continue
		}
		if s.matchWatch(w.serverID, w.remote, w.local, true) {
			queued++
		}
	}
	if queued > 0 {
		slog.Info("library source changed, watch folders matched again", "roots", len(roots), "queued", queued)
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
	// the server scans its own path: a folder mounted here under another
	// prefix (plex_roots "server => local") is named back the server's way
	_, maps := s.plexRootConfig()
	back := make([][2]string, len(maps))
	for i, m := range maps {
		back[i] = [2]string{m[1], m[0]}
	}
	serverDir := applyPathMap(dir, back)
	for _, sec := range secs {
		if sec.Title != title {
			continue
		}
		if err := c.Refresh(sec.Key, serverDir); err != nil {
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
	return s.libraryEntry("plex_lib_map", folder)
}

// plexLibraryScope returns the match scope (anime | tvdb | tv | movie) of the
// Plex library owning a local folder, "" when the folder is in none.
func (s *Server) plexLibraryScope(folder string) string {
	return s.libraryEntry("plex_lib_scopes", folder)
}

// libraryEntry reads a "root\tvalue" per line setting and returns the value of
// the longest root containing folder.
func (s *Server) libraryEntry(key, folder string) string {
	if folder == "" || !strings.HasPrefix(folder, "/") {
		return ""
	}
	best := -1
	value := ""
	for _, ln := range splitLines(db.Setting(s.DB, key)) {
		root, v, ok := strings.Cut(ln, "\t")
		if ok && (folder == root || strings.HasPrefix(folder, root+"/")) && len(root) > best {
			best, value = len(root), v
		}
	}
	return value
}

// libraryScope turns a library's metadata source (the user's choice, else the
// default for the library) into the catalog scope its folders are matched in.
// A film library set to TVDB searches TVDB's films.
func libraryScope(sec plex.Section, src string) string {
	if src == "" {
		src = DefaultSectionSource(sec)
	}
	switch {
	case strings.HasPrefix(src, "anilist"):
		return "anime"
	case sec.Type == "movie" && src == "tvdb":
		return tvdbMovieSource
	case sec.Type == "movie":
		return "movie"
	case src == "tvdb":
		return "tvdb"
	}
	return "tv"
}

// RefreshPlexRoots is the exported entry point for wiring at startup.
func (s *Server) RefreshPlexRoots() { s.refreshPlexRoots() }

// refreshPlexRoots re-detects the Plex library mounts on demand (startup, and
// after the Plex connection settings change), independent of the hourly index.
func (s *Server) refreshPlexRoots() {
	s.syncMediaServer()
	c := s.plexClient()
	if c == nil {
		return
	}
	// another server (Plex to Jellyfin, or a reinstalled one) keys its items
	// differently: what was cached about the old one would hand out its deep
	// links and item keys for hours
	if mid, err := c.MachineID(); err == nil && mid != "" {
		if prev := db.Setting(s.DB, "media_server_id"); prev != mid {
			s.DB.Exec(`DELETE FROM anilist_cache WHERE key LIKE 'plex:machineid%'
				OR key IN ('plex:guididx:v4', 'plex:titleidx:v2', 'plex:showlist:v1')`)
			db.SetSetting(s.DB, "media_server_id", mid)
			if prev != "" {
				// the local quality index and the folder bridge describe the
				// old library: rebuild both against this one on the next sweep
				s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = 0`)
				s.DB.Exec(`DELETE FROM plex_reconciled`)
				db.SetSetting(s.DB, "plex_indexed_at", "")
				// a linked watchlist account belongs to the server kind it was
				// made for: a plex.tv account serves any Plex server, a
				// Jellyfin user token only the server that issued it
				if prevKind := db.Setting(s.DB, "media_server_kind"); prevKind != c.Kind() || c.Kind() == "jellyfin" {
					s.DB.Exec(`DELETE FROM plex_accounts`)
				}
				slog.Info("media server changed", "kind", c.Kind())
			}
			db.SetSetting(s.DB, "media_server_kind", c.Kind())
		}
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
	if file != "" && s.localExists(file) {
		folder = filepath.Dir(file)
		// the whole season folder, not just the one episode Plex named: a
		// dub that arrived late sits on the later files, and this is the
		// branch the upgrade cards actually compare against
		if q, ok := s.probeQuality(folder); ok {
			q.Probed = probeMeasured
			return q, folder
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
