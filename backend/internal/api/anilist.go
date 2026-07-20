package api

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// handleAnilistSearch searches AniList by title for the match dialog.
//
//	@Summary		Search AniList
//	@Description	Search AniList media by title.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			q	query		string	true	"Search query"
//	@Success		200	{array}		anilist.Media
//	@Failure		400	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/search [get]
func (s *Server) handleAnilistSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "q required")
		return
	}
	list, err := s.Anilist.Search(r.Context(), q)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleAnilistMedia resolves one AniList media id.
//
//	@Summary		AniList media
//	@Description	Fetch a single AniList media entry by id.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id	path		int	true	"AniList media id"
//	@Success		200	{object}	anilist.Media
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/media/{id} [get]
func (s *Server) handleAnilistMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	m, err := s.Anilist.Media(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

type catalogItem struct {
	Entry  remote.Entry   `json:"entry"`
	Media  *anilist.Media `json:"media,omitempty"`
	Source string         `json:"source,omitempty"` // anilist | tmdb:tv | tmdb:movie
	// Pending: metadata is being resolved in the background, poll again
	Pending bool `json:"pending,omitempty"`
	// Kind: heuristic movie/series classification, so films mixed into a series
	// library are told apart. "" when nothing is conclusive.
	Kind string `json:"kind,omitempty"` // movie | series
	// Local: what the folder holds on disk. Only set for the local catalog,
	// where the question is "what do I have", not "what can I fetch".
	Local *LocalStat `json:"local,omitempty"`
}

// folderKind classifies a catalog folder as a film or a series. The primary
// signal is the number of video files directly in the folder (from the remote
// index, when it has been crawled): exactly one video and no subfolders reads
// as a movie, several videos or any season subfolder as a series. The folder
// name ("... Movie ...") is the fallback when the folder isn't indexed yet.
// Empty when nothing is conclusive.
// ponytail: a folder full of separate movie files reads as "series"; refine
// only if movie-collection folders turn out to matter.
func (s *Server) folderKind(serverID int64, folder, name string) string {
	var vids, subdirs int
	rows, err := s.DB.Query(`SELECT name, is_dir FROM remote_index WHERE server_id = ? AND parent = ?`, serverID, folder)
	if err == nil {
		for rows.Next() {
			var n string
			var dir int
			rows.Scan(&n, &dir)
			if dir != 0 {
				subdirs++
			} else if transfer.VideoExt[strings.ToLower(path.Ext(n))] {
				vids++
			}
		}
		rows.Close()
	}
	switch {
	case vids == 1 && subdirs == 0:
		return "movie"
	case vids >= 2 || subdirs >= 1:
		return "series"
	case match.ParseName(name, "", "").Movie:
		return "movie" // not indexed yet → trust the name
	}
	return ""
}

// runJob runs fn in the background at most once per key at a time; duplicate
// keys are dropped while the first run is still in flight.
func (s *Server) runJob(key string, fn func(ctx context.Context)) {
	s.matchMu.Lock()
	if s.matchJobs == nil {
		s.matchJobs = map[string]bool{}
	}
	if s.matchJobs[key] {
		s.matchMu.Unlock()
		return
	}
	s.matchJobs[key] = true
	s.matchMu.Unlock()
	go func() {
		defer func() {
			s.matchMu.Lock()
			delete(s.matchJobs, key)
			s.matchMu.Unlock()
		}()
		// bounded wait in the rate-limiter queue; drops are retried by the
		// next catalog poll
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		fn(ctx)
	}()
}

type matchJob struct {
	serverID int64
	folder   string
	name     string
	force    bool // bypass the search cache (user-triggered re-match)
}

// seasonDirRe matches season folders like "2026-3 Summer" (quarter 1-4).
var seasonDirRe = regexp.MustCompile(`\b(\d{4})-([1-4])\b`)

// seasonFromPath extracts AniList season/year context from any path segment,
// e.g. "/Anime-Server/2026-3 Summer/ShowName" → SUMMER, 2026.
func seasonFromPath(p string) (string, int) {
	for _, seg := range strings.Split(p, "/") {
		if m := seasonDirRe.FindStringSubmatch(seg); m != nil {
			year, _ := strconv.Atoi(m[1])
			return [...]string{"WINTER", "SPRING", "SUMMER", "FALL"}[m[2][0]-'1'], year
		}
	}
	return "", 0
}

// queueMatch resolves folder → AniList media in the background. Jobs are
// deduplicated and drained in batches of 10 by a single worker (one GraphQL
// request per batch). Persists only on a successful search so failures are
// retried by a later catalog poll.
func (s *Server) queueMatch(serverID int64, folder, name string, force bool) {
	key := fmt.Sprintf("m:%d:%s", serverID, folder)
	s.matchMu.Lock()
	if s.matchJobs == nil {
		s.matchJobs = map[string]bool{}
	}
	if s.matchJobs[key] {
		s.matchMu.Unlock()
		return
	}
	s.matchJobs[key] = true
	s.matchMu.Unlock()
	s.matchOnce.Do(func() {
		s.matchCh = make(chan matchJob, 8192)
		go s.matchWorker()
	})
	select {
	case s.matchCh <- matchJob{serverID, folder, name, force}:
	default: // queue full: drop, the next poll re-queues
		s.dropJob(key)
	}
}

func (s *Server) dropJob(key string) {
	s.matchMu.Lock()
	delete(s.matchJobs, key)
	s.matchMu.Unlock()
}

func (s *Server) matchWorker() {
	for job := range s.matchCh {
		batch := []matchJob{job}
	drain:
		for len(batch) < 10 {
			select {
			case j := <-s.matchCh:
				batch = append(batch, j)
			default:
				break drain
			}
		}
		s.matchBatch(batch)
	}
}

func (s *Server) matchBatch(batch []matchJob) {
	defer func() {
		for _, b := range batch {
			s.dropJob(fmt.Sprintf("m:%d:%s", b.serverID, b.folder))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	reqs := make([]anilist.SearchReq, len(batch))
	for i, b := range batch {
		season, year := seasonFromPath(b.folder)
		reqs[i] = anilist.SearchReq{Query: GuessTitle(b.name), Season: season, Year: year, Force: b.force}
	}
	results, err := s.Anilist.SearchBatch(ctx, reqs)
	if err != nil {
		return
	}
	// fallback chain for empty results: season-filtered miss → unfiltered
	// search → alternative title from parens ("Romaji (English)" folders) →
	// normalized query (typographic quotes, diacritics) → base title with
	// season/OVA markers stripped
	runFallback := func(idx []int, build func(i int) anilist.SearchReq) {
		if len(idx) == 0 {
			return
		}
		sub := make([]anilist.SearchReq, len(idx))
		for n, i := range idx {
			sub[n] = build(i)
		}
		if fb, ferr := s.Anilist.SearchBatch(ctx, sub); ferr == nil {
			for n, i := range idx {
				results[i] = fb[n]
			}
		}
	}
	var retry []int
	for i := range results {
		if len(results[i]) == 0 && (reqs[i].Season != "" || reqs[i].Year != 0) {
			retry = append(retry, i)
		}
	}
	runFallback(retry, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: reqs[i].Query, Force: reqs[i].Force}
	})
	var alt []int
	for i, b := range batch {
		if len(results[i]) == 0 && GuessAltTitle(b.name) != "" {
			alt = append(alt, i)
		}
	}
	runFallback(alt, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: GuessAltTitle(batch[i].name), Force: reqs[i].Force}
	})
	infos := make([]match.Info, len(batch))
	for i, b := range batch {
		infos[i] = match.ParseName(b.name, reqs[i].Query, GuessAltTitle(b.name))
	}
	var normed []int
	for i := range results {
		if len(results[i]) == 0 && match.Normalize(reqs[i].Query) != normTitle(reqs[i].Query) {
			normed = append(normed, i)
		}
	}
	runFallback(normed, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.Normalize(reqs[i].Query), Force: reqs[i].Force}
	})
	var stripped []int
	for i := range results {
		if len(results[i]) == 0 && (infos[i].Season >= 2 || infos[i].OVA) {
			if base := match.StripMarkers(reqs[i].Query); base != "" && normTitle(base) != normTitle(reqs[i].Query) {
				stripped = append(stripped, i)
			}
		}
	}
	runFallback(stripped, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.StripMarkers(reqs[i].Query), Force: reqs[i].Force}
	})

	// pick the best-scoring candidate per folder instead of the first hit;
	// a non-confident best for an explicit sequel folder is kept tentatively
	// so the relations pass can confirm or discard it
	picked := make([]*anilist.Media, len(batch))
	rescue := make([]bool, len(batch))
	for i := range batch {
		if len(results[i]) == 0 {
			continue
		}
		idx, ok := match.Pick(infos[i], results[i])
		if ok {
			picked[i] = &results[i][idx]
		} else if infos[i].Season >= 2 && match.SeasonOf(results[i][idx]) == 0 {
			picked[i], rescue[i] = &results[i][idx], true
		}
	}
	s.fixSequelPicks(ctx, infos, picked, rescue)
	for i, b := range batch {
		mediaID := 0
		if picked[i] != nil {
			mediaID = picked[i].ID
			s.Anilist.CacheMedia(picked[i])
		}
		s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual) VALUES (?, ?, ?, 0)`,
			b.serverID, b.folder, mediaID)
	}
}

// fixSequelPicks resolves folders that name season N but whose pick carries
// no season marker, using relation edges (batched 10/request, cached):
//   - a pick with a PREQUEL edge already is a sequel entry ("Ni no Shou",
//     "Ultra Romantic") - keep it, walking onward would overshoot;
//   - a true base entry is upgraded to the N-th SEQUEL-chain entry when the
//     chain is long enough (3 relation waves, so up to season 4).
//
// Confident picks are never dropped (never worse than today's first hit);
// rescue picks (below the confidence threshold) survive only when the
// relations confirm them.
func (s *Server) fixSequelPicks(ctx context.Context, infos []match.Info, picked []*anilist.Media, rescue []bool) {
	var fix []int
	frontier := map[int]bool{}
	for i, m := range picked {
		if m != nil && infos[i].Season >= 2 && match.SeasonOf(*m) == 0 {
			fix = append(fix, i)
			frontier[m.ID] = true
		}
	}
	if len(fix) == 0 {
		return
	}
	rels := map[int][]anilist.Relation{}
	for range [3]int{} {
		var ids []int
		for id := range frontier {
			if _, ok := rels[id]; !ok {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			break
		}
		got, err := s.Anilist.RelationsBatch(ctx, ids)
		if err != nil {
			break // judge with what we have
		}
		frontier = map[int]bool{}
		for id, r := range got {
			rels[id] = r
			for _, e := range r {
				if e.RelationType == "SEQUEL" && sequelFormats[e.Node.Format] {
					frontier[e.Node.ID] = true
				}
			}
		}
	}
	for _, i := range fix {
		edges, known := rels[picked[i].ID]
		if !known {
			if rescue[i] {
				picked[i] = nil // unconfirmed low-score pick
			}
			continue
		}
		if hasPrequel(edges) {
			continue // already a sequel entry, keep it
		}
		if m := seasonTarget(walkChain(*picked[i], rels, sequelFormats), infos[i].Season); m != nil {
			picked[i] = m
		} else if rescue[i] {
			picked[i] = nil
		}
	}
}

// seasonTarget scans a SEQUEL chain (base first) for the entry representing
// season want. Positions advance by the nodes' own markers where present:
// AniList splits some seasons into "Part 2" entries that must not count as
// a full season step ("Attack on Titan Season 3 Part 2").
func seasonTarget(chain []anilist.Media, want int) *anilist.Media {
	pos := 1
	for k := 1; k < len(chain); k++ {
		if so := match.SeasonOf(chain[k]); so > 0 {
			pos = so
		} else {
			pos++ // unmarked entry or FINAL season: one season further
		}
		switch {
		case pos == want:
			return &chain[k]
		case pos > want:
			return nil
		}
	}
	return nil
}

// hasPrequel reports whether the relation edges include a series PREQUEL.
func hasPrequel(edges []anilist.Relation) bool {
	for _, e := range edges {
		if e.RelationType == "PREQUEL" && (sequelFormats[e.Node.Format] || e.Node.Format == "MOVIE") {
			return true
		}
	}
	return false
}

// queueMediaFetch refreshes missing/stale media metadata in the background.
func (s *Server) queueMediaFetch(id int) {
	s.runJob(fmt.Sprintf("f:%d", id), func(ctx context.Context) {
		s.Anilist.Media(ctx, id) // stores into the cache on success
	})
}

// GuessTitle/GuessAltTitle live in internal/match; the aliases keep the
// call sites (and their tests) in this package unchanged.
var (
	GuessTitle    = match.GuessTitle
	GuessAltTitle = match.GuessAltTitle
)

// catalogResponse is the enriched folder listing returned by handleCatalog.
type catalogResponse struct {
	Scope     string        `json:"scope"`     // "" | anime | tv | movie
	Inherited bool          `json:"inherited"` // scope comes from an ancestor mark
	Items     []catalogItem `json:"items"`
}

// handleCatalog lists remote folders enriched with AniList metadata. The
// structure is returned immediately; unmatched folders are resolved by
// background jobs and flagged pending so the client polls until done.
//
//	@Summary		Server catalog
//	@Description	List a server's remote folders enriched with AniList/TMDB metadata; unmatched folders are flagged pending.
//	@Tags			Catalog
//	@Produce		json
//	@Param			id		path		int		true	"Server id"
//	@Param			path	query		string	false	"Directory to list (defaults to the server root)"
//	@Success		200		{object}	catalogResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog [get]
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	dir := r.URL.Query().Get("path")
	var entries []remote.Entry
	if serverID == localServerID {
		// id 0 is the local filesystem: same scopes, matches and background
		// jobs as a remote server, just a different listing source
		var err error
		if dir == "" {
			dir = "/" // scopes key on a non-empty path
		}
		if entries, err = s.listLocal(dir); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
	} else {
		client, rootPath, err := s.DialServer(u.ID, serverID)
		if err != nil {
			status := http.StatusBadGateway
			if err == errNotFound {
				status = http.StatusNotFound
			}
			writeErr(w, status, err.Error())
			return
		}
		defer client.Close()
		if dir == "" {
			dir = rootPath
		}
		if entries, err = client.List(dir); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
	}

	scope := s.scopeFor(serverID, dir)
	items := []catalogItem{}
	for _, e := range entries {
		if !e.IsDir {
			continue
		}
		item := catalogItem{Entry: e}
		item.Kind = s.folderKind(serverID, e.Path, e.Name)
		if serverID == localServerID {
			if abs, aerr := s.safeLocal(e.Path); aerr == nil {
				st := s.localStat(abs)
				item.Local = &st
				// no remote index locally: the file counts classify instead
				if item.Kind == "" && st.Videos > 0 {
					item.Kind = "series"
					if st.Videos == 1 {
						item.Kind = "movie"
					}
				}
			}
		}
		if scope == "" {
			// no metadata source chosen for this path yet: show the plain
			// structure and wait for the user to pick one (persisted mark)
			items = append(items, item)
			continue
		}
		// route an obvious film in a TMDB-series library to the movie source,
		// so a movie mixed into a tv scope matches against films, not shows
		itemScope := scope
		if item.Kind == "movie" && scope == "tv" {
			itemScope = "movie"
		}
		itemSource := sourceForScope(itemScope)
		item.Source = itemSource
		var mediaID, manual int
		var rowSource string
		err := s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches
			WHERE server_id = ? AND folder = ?`, serverID, e.Path).Scan(&mediaID, &manual, &rowSource)
		switch {
		case err != nil || rowSource != itemSource:
			// an identically named folder elsewhere (another server, or the
			// local copy of what was synced from one) already resolved to a
			// media entry - adopt it instead of searching for the same name
			// again
			if id, ok := s.reuseMatch(serverID, e.Name, itemSource); ok {
				s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source)
					VALUES (?, ?, ?, 0, ?)`, serverID, e.Path, id, itemSource)
				item.Media, item.Pending = s.sourceMedia(itemSource, id)
				break
			}
			// never looked up, or the folder's scope changed since the match
			// was stored: match in the background, show the folder now
			item.Pending = true
			s.queueScopedMatch(serverID, e.Path, e.Name, itemScope, false)
		case mediaID == 0 && manual == 0:
			// searched before, nothing found: display "no match" but retry
			// quietly (search cache makes this cheap); manual unmatch is final
			s.queueScopedMatch(serverID, e.Path, e.Name, itemScope, false)
		case mediaID != 0:
			item.Media, item.Pending = s.sourceMedia(itemSource, mediaID)
		}
		items = append(items, item)
	}
	var ownKind string
	s.DB.QueryRow(`SELECT kind FROM catalog_scopes WHERE server_id = ? AND path = ?`, serverID, dir).Scan(&ownKind)
	writeJSON(w, http.StatusOK, catalogResponse{
		Scope:     scope,
		Inherited: scope != "" && ownKind == "",
		Items:     items,
	})
}

// reuseMatch looks for a folder with the same base name that another source
// already matched against the same provider. Local folders are usually copies
// of remote ones, so this saves the identical search - and searching the same
// name would return the same media anyway.
//
// Adopted only when every existing match agrees: two sources disagreeing about
// the same folder name means at least one is wrong, and a fresh search beats
// spreading a bad match. Returns 0/false when nothing fits.
func (s *Server) reuseMatch(serverID int64, name, source string) (int, bool) {
	suffix := "/" + name
	// suffix compare instead of LIKE: folder names contain % and _ often
	// enough that escaping would be the fiddlier option
	rows, err := s.DB.Query(`SELECT DISTINCT media_id FROM catalog_matches
		WHERE source = ? AND media_id != 0 AND server_id != ?
		  AND substr(folder, length(folder) - length(?) + 1) = ?
		LIMIT 2`, source, serverID, suffix, suffix)
	if err != nil {
		return 0, false
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		rows.Scan(&id)
		ids = append(ids, id)
	}
	if len(ids) != 1 {
		return 0, false
	}
	return ids[0], true
}

// queueScopedMatch dispatches folder matching to the scope's metadata source.
func (s *Server) queueScopedMatch(serverID int64, folder, name, scope string, force bool) {
	if scope == "" || scope == "anime" {
		s.queueMatch(serverID, folder, name, force)
		return
	}
	if scope == "tvdb" {
		s.queueTvdbMatch(serverID, folder, name, force)
		return
	}
	s.queueTmdbMatch(serverID, folder, name, scope, force)
}

// rematchRequest is the body of handleCatalogRematch.
type rematchRequest struct {
	Path string `json:"path"`
	All  bool   `json:"all"`
}

// rematchResponse reports how many folders were re-queued.
type rematchResponse struct {
	Queued int `json:"queued"`
}

// handleCatalogRematch re-queues automatic matches directly under the given
// path with a forced (cache-bypassing) search: by default only "no match"
// folders, with all=true every automatic match. Manual matches/unmatches
// (manual=1) are always left alone.
//
//	@Summary		Re-match catalog folders
//	@Description	Re-queue automatic folder matches under a path with a cache-bypassing search.
//	@Tags			Catalog
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int				true	"Server id"
//	@Param			body	body		rematchRequest	true	"Path and whether to re-match all folders"
//	@Success		200		{object}	rematchResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/rematch [post]
func (s *Server) handleCatalogRematch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var in rematchRequest
	if !readJSON(w, r, &in) {
		return
	}
	// ownership check doubles as root path lookup (empty path = root); the
	// local pseudo server has neither, its root is "/"
	if serverID == localServerID {
		if in.Path == "" {
			in.Path = "/"
		}
	} else {
		var rootPath string
		if err := s.DB.QueryRow(`SELECT root_path FROM servers WHERE id = ? AND user_id = ?`,
			serverID, u.ID).Scan(&rootPath); err != nil {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
		if in.Path == "" {
			in.Path = rootPath
		}
	}
	if in.Path == "" || path.Clean(in.Path) != in.Path {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	scope := s.scopeFor(serverID, in.Path)
	if scope == "" {
		// no metadata source chosen: nothing to re-match
		writeJSON(w, http.StatusOK, rematchResponse{Queued: 0})
		return
	}
	// direct children only: no second slash after the prefix
	cond := "AND media_id = 0"
	if in.All {
		cond = ""
	}
	rows, err := s.DB.Query(`SELECT folder FROM catalog_matches
		WHERE server_id = ? AND manual = 0 AND source = ? `+cond+`
		AND folder LIKE ? || '/%' AND folder NOT LIKE ? || '/%/%'`,
		serverID, sourceForScope(scope), in.Path, in.Path)
	if err != nil {
		dbErr(w)
		return
	}
	var folders []string
	for rows.Next() {
		var f string
		rows.Scan(&f)
		folders = append(folders, f)
	}
	rows.Close()
	for _, f := range folders {
		s.queueScopedMatch(serverID, f, path.Base(f), scope, true)
		// drop the row so the catalog shows these as pending while the
		// forced search runs (poll picks the fresh result up)
		s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ? AND folder = ? AND manual = 0`, serverID, f)
	}
	writeJSON(w, http.StatusOK, rematchResponse{Queued: len(folders)})
}

// catalogMatchRequest is the body of handleCatalogMatch.
type catalogMatchRequest struct {
	Folder  string `json:"folder"`
	MediaID int    `json:"mediaId"` // 0 = unmatch
}

// handleCatalogMatch sets or clears a manual folder→media match.
//
//	@Summary		Set catalog match
//	@Description	Set or clear a manual folder→media match (mediaId 0 = unmatch).
//	@Tags			Catalog
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int					true	"Server id"
//	@Param			body	body		catalogMatchRequest	true	"Folder and media id"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/match [put]
func (s *Server) handleCatalogMatch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	var in catalogMatchRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.Folder == "" || path.Clean(in.Folder) != in.Folder {
		writeErr(w, http.StatusBadRequest, "invalid folder")
		return
	}
	// ownership check: the server must belong to the user
	var owned int
	s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned)
	if owned == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, 1, ?)`,
		serverID, in.Folder, in.MediaID, sourceForScope(s.scopeFor(serverID, in.Folder)))
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
