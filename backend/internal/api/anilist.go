package api

import (
	"context"
	"fmt"
	"log/slog"
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
//	@Description	Search AniList media by title, anime unless type=manga.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			q		query		string	true	"Search query"
//	@Param			type	query		string	false	"anime (default) | manga"
//	@Success		200		{array}		anilist.Media
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
	if r.URL.Query().Get("type") == "manga" {
		res, err := s.Anilist.SearchBatch(r.Context(), []anilist.SearchReq{{Query: q, Manga: true}})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, append([]anilist.Media{}, res[0]...))
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
	// Hint: a suggestion from TMDB for a folder AniList found nothing for.
	// Not a match: the user confirms it through the match endpoint or drops it.
	Hint *matchHint `json:"hint,omitempty"`
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
	var video string
	rows, err := s.DB.Query(`SELECT name, is_dir FROM remote_index WHERE server_id = ? AND parent = ?`, serverID, folder)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var n string
			var dir int
			if err := rows.Scan(&n, &dir); err != nil {
				vids, subdirs = 0, 0 // half a listing is no evidence: decide by name
				break
			}
			if dir != 0 {
				subdirs++
			} else if transfer.VideoExt[strings.ToLower(path.Ext(n))] {
				vids++
				video = n
			}
		}
		if rows.Err() != nil {
			vids, subdirs = 0, 0 // half a listing is no evidence: decide by name
		}
	}
	switch {
	case vids == 1 && subdirs == 0 && isEpisodeFile(video):
		// a show that has only just started: one file so far, and it says
		// which episode it is
		return "series"
	case vids == 1 && subdirs == 0:
		return "movie"
	case vids >= 2 || subdirs >= 1:
		return "series"
	case match.ParseName(name, "", "").Movie:
		return "movie" // not indexed yet → trust the name
	}
	return ""
}

// episodeMarkRe finds an episode marker no film name carries: "S01E01", "E01"
// as a word of its own, or " - 01" (the release convention). A bare number is
// not one - "Nobody.2.(2025)" and "10 Cloverfield Lane" are films.
var (
	episodeMarkRe = regexp.MustCompile(`(?i)(?:\bS\d{1,2}E\d{1,4}\b|(?:^|[\s._\[(])E\d{1,4}(?:v\d)?(?:$|[\s._\])])| - \d{1,4}(?:v\d)?(?:$|[\s.\[(]))`)
	filmWordRe    = regexp.MustCompile(`(?i)\b(?:movie|film|gekijouban)\b`)
)

// isEpisodeFile reports whether a video's name says it is an episode. The
// words movie, film and gekijouban keep a film a film even with a marker
// ("... Movie - 365 Days", a film filed as S00E02).
func isEpisodeFile(name string) bool {
	return episodeMarkRe.MatchString(name) && !filmWordRe.MatchString(name)
}

// kindFromStat classifies by the video files a folder holds - the local
// catalog's fallback, where there is no remote index to read. One video is a
// film unless it names its episode.
func kindFromStat(st LocalStat) string {
	switch {
	case st.Videos == 1 && st.episodes == 1:
		return "series"
	case st.Videos == 1:
		return "movie"
	case st.Videos > 1:
		return "series"
	}
	return ""
}

// itemKind classifies a single catalog folder the way handleCatalog does when
// it lists the folder's parent, local file counts included.
func (s *Server) itemKind(serverID int64, folder, name string) string {
	kind := s.folderKind(serverID, folder, name)
	if kind == "" && serverID == localServerID {
		if abs, err := s.safeLocal(folder); err == nil {
			kind = kindFromStat(s.localStat(abs))
		}
	}
	return kind
}

// scopeForItem narrows a folder's scope for one entry: an obvious film in a TMDB
// series library is matched against films, not shows. Listing (handleCatalog)
// and manual correction (handleCatalogMatch) must derive this identically, or
// the stored match carries a foreign source tag and is dropped on the next
// listing - which is how manual matches on films used to disappear.
func scopeForItem(scope, kind string) string {
	switch {
	case scope == "tv" && kind == "movie":
		return "movie"
	case scope == "tvdb" && kind == "movie":
		return tvdbMovieSource // TVDB keeps its films apart from its series
	}
	return scope
}

// tvdbMovieSource tags a film matched on TVDB, as scope and as source: TVDB
// numbers films apart from series, so a film id under "tvdb" names a series.
const tvdbMovieSource = "tvdb:movie"

// runJob runs fn in the background at most once per key at a time; duplicate
// keys are dropped while the first run is still in flight. Five minutes is the
// bounded wait in the rate-limiter queue; drops are retried by the next catalog
// poll. A pass that legitimately takes longer uses runJobFor.
func (s *Server) runJob(key string, fn func(ctx context.Context)) {
	s.runJobFor(key, 5*time.Minute, fn)
}

// runJobFor is runJob with an explicit deadline. The job's cancel function is
// kept while it runs, which is what lets an admin stop it from the jobs page,
// and a job whose family is paused never starts.
func (s *Server) runJobFor(key string, limit time.Duration, fn func(ctx context.Context)) {
	if s.jobPaused(key) {
		slog.Debug("job skipped", "job", key, "reason", "paused")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	s.matchMu.Lock()
	if s.matchJobs == nil {
		s.matchJobs = map[string]context.CancelFunc{}
	}
	if _, running := s.matchJobs[key]; running {
		s.matchMu.Unlock()
		cancel()
		return
	}
	s.matchJobs[key] = cancel
	s.matchMu.Unlock()
	go func() {
		defer func() {
			cancel()
			s.matchMu.Lock()
			delete(s.matchJobs, key)
			s.matchMu.Unlock()
		}()
		fn(ctx)
	}()
}

type matchJob struct {
	serverID int64
	folder   string
	name     string
	force    bool // bypass the search cache (user-triggered re-match)
	manga    bool // search AniList's MANGA catalogue, stored as anilist:manga
	// a folder under an "automatic" mark: what to do with the pick (see
	// auto_match.go); nil for every other scope
	auto *autoPlan
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
func (s *Server) queueMatch(serverID int64, folder, name string, force, manga bool) {
	s.enqueueMatch(matchJob{serverID: serverID, folder: folder, name: name, force: force, manga: manga})
}

// enqueueMatch puts one folder into the AniList batch queue.
func (s *Server) enqueueMatch(job matchJob) {
	serverID, folder := job.serverID, job.folder
	key := fmt.Sprintf("m:%d:%s", serverID, folder)
	if s.jobPaused(key) {
		return
	}
	s.matchMu.Lock()
	if s.matchJobs == nil {
		s.matchJobs = map[string]context.CancelFunc{}
	}
	if _, running := s.matchJobs[key]; running {
		s.matchMu.Unlock()
		return
	}
	// a queued match owns no context of its own: it is drained by the batch
	// worker, and stopping one file's lookup is not something to offer
	s.matchJobs[key] = func() {}
	s.matchMu.Unlock()
	s.matchOnce.Do(func() {
		s.matchCh = make(chan matchJob, 8192)
		go s.matchWorker()
	})
	select {
	case s.matchCh <- job:
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

	results, infos, trace, err := s.searchChain(ctx, batch)
	if err != nil {
		return
	}

	// pick the best-scoring candidate per folder instead of the first hit;
	// a non-confident best for an explicit sequel folder is kept tentatively
	// so the relations pass can confirm or discard it
	picked := make([]*anilist.Media, len(batch))
	rescue := make([]bool, len(batch))
	for i := range batch {
		if len(results[i]) == 0 {
			slog.Debug("match unresolved", "folder", logSafe(batch[i].folder), "reason", "no candidates after fallbacks")
			continue
		}
		idx, ok := match.Pick(infos[i], results[i])
		switch {
		case ok:
			picked[i] = &results[i][idx]
			slog.Debug("match picked", "folder", logSafe(batch[i].folder), "media", picked[i].ID,
				"title", picked[i].Title.Romaji, "candidates", len(results[i]), "confident", true)
		case rescuable(infos[i], results[i][idx], batch[i].manga):
			picked[i], rescue[i] = &results[i][idx], true
			// sequel folder, best candidate has no season marker: keep it
			// tentatively for the relations pass to confirm or discard
			slog.Debug("match picked", "folder", logSafe(batch[i].folder), "media", picked[i].ID,
				"title", picked[i].Title.Romaji, "candidates", len(results[i]),
				"confident", false, "rescue", true, "season", infos[i].Season)
		default:
			slog.Debug("match unresolved", "folder", logSafe(batch[i].folder),
				"candidates", len(results[i]), "reason", "no confident candidate")
		}
	}
	s.fixSequelPicks(ctx, infos, picked, rescue)
	gateAutoPicks(batch, infos, picked)
	var unmatched []int
	for i, b := range batch {
		// a match the user set stays, whatever source it is from: only an
		// explicit re-match (force) is a choice against it
		if !b.force && s.hasManualMatch(b.serverID, b.folder) {
			continue
		}
		// a search that failed (AniList down, the main query answered from
		// the cache) says nothing: the stored match stays, the next poll asks
		if picked[i] == nil && searchFailed(trace[i]) {
			slog.Debug("match skipped", "folder", logSafe(b.folder), "reason", "a search failed")
			continue
		}
		mediaID := 0
		if picked[i] != nil {
			mediaID = picked[i].ID
			s.Anilist.CacheMedia(picked[i])
		}
		src := "anilist"
		if b.manga {
			src = mangaSource
		}
		if mediaID == 0 && b.auto != nil && len(b.auto.rest) > 0 {
			// AniList had no confident answer: the next providers are asked off
			// this worker, which is the AniList queue and must not wait on them
			s.queueAutoFallback(b, infos[i])
			continue
		}
		// persistMatch logs a failure; the folder is matched again on a later pass
		_ = s.persistMatch(b.serverID, b.folder, mediaID, false, src)
		if mediaID == 0 && !b.manga {
			unmatched = append(unmatched, i)
		}
	}
	// what AniList left over may be western animation or live action: TMDB
	// gets a say, as a hint only (see hintFolder)
	hctx, hcancel := context.WithTimeout(context.Background(), time.Minute)
	defer hcancel()
	s.hintBatch(hctx, batch, infos, unmatched)
}

// searchFailed reports whether one of a folder's searches got no answer.
func searchFailed(steps []searchStep) bool {
	for _, st := range steps {
		if st.Hits < 0 {
			return true
		}
	}
	return false
}

// rescuable reports whether a non-confident best candidate is kept for the
// relations pass: the folder names a sequel season and the candidate carries
// no season marker, so its SEQUEL chain may still lead to the right entry.
func rescuable(info match.Info, best anilist.Media, manga bool) bool {
	return info.Season >= 2 && match.SeasonOf(best) == 0 && !manga
}

// searchStep is one search of the match chain for one folder: the stage that
// ran it, the query and how many candidates came back (-1: the request failed).
type searchStep struct {
	Stage  string `json:"stage" enums:"search,unfiltered,alt-title,normalized,stripped-markers,relaxed"`
	Query  string `json:"query"`
	Season string `json:"season,omitempty"`
	Year   int    `json:"year,omitempty"`
	Hits   int    `json:"hits"`
}

// searchChain runs the catalog search for a batch of folders: the title with
// the season folder's context, then the fallbacks for whatever came back
// empty. It returns the candidates and the parsed name per folder, and every
// search that ran for it, so an explanation replays exactly what matching did.
func (s *Server) searchChain(ctx context.Context, batch []matchJob) ([][]anilist.Media, []match.Info, [][]searchStep, error) {
	reqs := make([]anilist.SearchReq, len(batch))
	trace := make([][]searchStep, len(batch))
	for i, b := range batch {
		season, year := seasonFromPath(b.folder)
		reqs[i] = anilist.SearchReq{Query: GuessTitle(b.name), Season: season, Year: year, Force: b.force, Manga: b.manga}
	}
	results, err := s.Anilist.SearchBatch(ctx, reqs)
	if err != nil {
		return nil, nil, nil, err
	}
	for i := range batch {
		trace[i] = append(trace[i], searchStep{Stage: "search", Query: reqs[i].Query, Season: reqs[i].Season, Year: reqs[i].Year, Hits: len(results[i])})
	}
	// fallback chain for empty results: season-filtered miss → unfiltered
	// search → alternative title from parens ("Romaji (English)" folders) →
	// normalized query (typographic quotes, diacritics) → base title with
	// season/OVA markers stripped
	runFallback := func(stage string, idx []int, build func(i int) anilist.SearchReq) {
		if len(idx) == 0 {
			return
		}
		sub := make([]anilist.SearchReq, len(idx))
		for n, i := range idx {
			sub[n] = build(i)
		}
		fb, ferr := s.Anilist.SearchBatch(ctx, sub)
		for n, i := range idx {
			hits := -1
			if ferr == nil {
				hits = len(fb[n])
			}
			trace[i] = append(trace[i], searchStep{Stage: stage, Query: sub[n].Query, Hits: hits})
		}
		if ferr == nil {
			for n, i := range idx {
				results[i] = fb[n]
				// which rescue stage recovered a previously empty result, and
				// with which query - a 4th-stage hit is invisible in the DB
				if len(fb[n]) > 0 {
					slog.Debug("match fallback hit", "stage", stage,
						"folder", logSafe(batch[i].folder), "query", sub[n].Query, "candidates", len(fb[n]))
				}
			}
		}
	}
	var retry []int
	for i := range results {
		if len(results[i]) == 0 && (reqs[i].Season != "" || reqs[i].Year != 0) {
			retry = append(retry, i)
		}
	}
	runFallback("unfiltered", retry, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: reqs[i].Query, Force: reqs[i].Force, Manga: reqs[i].Manga}
	})
	var alt []int
	for i, b := range batch {
		if len(results[i]) == 0 && GuessAltTitle(b.name) != "" {
			alt = append(alt, i)
		}
	}
	runFallback("alt-title", alt, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: GuessAltTitle(batch[i].name), Force: reqs[i].Force, Manga: reqs[i].Manga}
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
	runFallback("normalized", normed, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.Normalize(reqs[i].Query), Force: reqs[i].Force, Manga: reqs[i].Manga}
	})
	var stripped []int
	for i := range results {
		if len(results[i]) == 0 && (infos[i].Season >= 2 || infos[i].OVA || match.TrailingOrdinal(reqs[i].Query) >= 2) {
			if base := match.StripFolderMarkers(reqs[i].Query); base != "" && normTitle(base) != normTitle(reqs[i].Query) {
				stripped = append(stripped, i)
			}
		}
	}
	runFallback("stripped-markers", stripped, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.StripFolderMarkers(reqs[i].Query), Force: reqs[i].Force, Manga: reqs[i].Manga}
	})
	// "Dai Hachi Gakari 2nd" is read as season 2 only now that the title as
	// written found nothing: "Major 2nd" is a title, and keeps its meaning
	for _, i := range stripped {
		if n := match.TrailingOrdinal(reqs[i].Query); len(results[i]) > 0 && infos[i].Season == 0 && n >= 2 {
			infos[i].Season = n
		}
	}
	// the paren alias carries the season too ("(Fire Force S2)"): search its
	// base title, the season stays in infos for scoring and the sequel walk
	var altBase []int
	for i, b := range batch {
		if alt := GuessAltTitle(b.name); len(results[i]) == 0 && alt != "" {
			if base := match.StripFolderMarkers(alt); base != "" && normTitle(base) != normTitle(alt) {
				altBase = append(altBase, i)
			}
		}
	}
	runFallback("stripped-markers", altBase, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.StripFolderMarkers(GuessAltTitle(batch[i].name)), Force: reqs[i].Force, Manga: reqs[i].Manga}
	})
	// "... - Orion no Ya Movie": AniList has the film without the word
	var movie []int
	for i := range results {
		if len(results[i]) == 0 && infos[i].Movie {
			if base := match.StripMovieWord(reqs[i].Query); base != "" && normTitle(base) != normTitle(reqs[i].Query) {
				movie = append(movie, i)
			}
		}
	}
	runFallback("stripped-markers", movie, func(i int) anilist.SearchReq {
		return anilist.SearchReq{Query: match.StripMovieWord(reqs[i].Query), Force: reqs[i].Force, Manga: reqs[i].Manga}
	})
	// a folder that says Movie is not the TV series sharing the title
	for _, i := range movie {
		kept := results[i][:0:0]
		for _, m := range results[i] {
			if m.Format != "TV" && m.Format != "TV_SHORT" {
				kept = append(kept, m)
			}
		}
		results[i] = kept
	}
	s.relaxedSearch(batch, reqs, infos, results, runFallback)
	return results, infos, trace, nil
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
		// a failed batch still returns the part it resolved: use it
		got, err := s.Anilist.RelationsBatch(ctx, ids)
		frontier = map[int]bool{}
		for id, r := range got {
			rels[id] = r
			for _, e := range r {
				if e.RelationType == "SEQUEL" && sequelFormats[e.Node.Format] {
					frontier[e.Node.ID] = true
				}
			}
		}
		if err != nil {
			break // judge with what we have
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
		base := picked[i].ID
		if m := seasonTarget(walkChain(*picked[i], rels, sequelFormats), infos[i].Season); m != nil {
			picked[i] = m
			slog.Debug("sequel chain resolved", "media", m.ID, "title", m.Title.Romaji,
				"season", infos[i].Season, "base", base)
		} else if rescue[i] {
			picked[i] = nil
			slog.Debug("sequel chain unresolved", "base", base, "season", infos[i].Season,
				"reason", "no season entry in chain, rescue dropped")
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
		// expire first: Media() would otherwise answer from a cache entry that
		// is still fresh but written with an older field set (see sourceMedia)
		s.refetchCached(fmt.Sprintf("media:%d", id), func() error {
			_, err := s.Anilist.Media(ctx, id) // stores into the cache on success
			return err
		})
	})
}

// refetchCached fetches a cache entry again. The row is never removed: it is
// only dated back so the client's fresh-only read misses it and asks the
// provider, while every display read (CachedMedia) keeps showing it. When the
// fetch fails (the provider is down) its own date comes back, so the daily
// prune judges it by its real age. Dropping the row instead emptied every
// airing show's title and cover for as long as an outage lasted, and even
// with a restore after the failure the row was gone while the retries ran.
func (s *Server) refetchCached(key string, fetch func() error) {
	var fetched string
	had := s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, key).Scan(&fetched) == nil
	// a failed expiry only means the refetch may answer from the older entry
	_, _ = s.DB.Exec(`UPDATE anilist_cache SET fetched_at = ? WHERE key = ?`, expiredStamp, key)
	if fetch() == nil || !had {
		return
	}
	// a successful store rewrote the date; only an unchanged expired row is reset
	if _, err := s.DB.Exec(`UPDATE anilist_cache SET fetched_at = ? WHERE key = ? AND fetched_at = ?`, fetched, key, expiredStamp); err != nil {
		slog.Warn("cache entry date not restored after a failed refresh", "key", logSafe(key), "err", err)
	}
}

// expiredStamp dates a cache row older than any TTL.
const expiredStamp = "1970-01-01 00:00:00"

// GuessTitle/GuessAltTitle live in internal/match; the aliases keep the
// call sites (and their tests) in this package unchanged.
var (
	GuessTitle    = match.GuessTitle
	GuessAltTitle = match.GuessAltTitle
)

// catalogResponse is the enriched folder listing returned by handleCatalog.
type catalogResponse struct {
	Scope string `json:"scope"` // "" | anime | tv | movie
	// MatchingOff: the mark's provider is switched off for matching (settings),
	// so the folders below that have no match are not being looked up
	MatchingOff bool          `json:"matchingOff,omitempty"`
	Items       []catalogItem `json:"items"`
	// Upcoming: series of a season folder's season that the folder lacks
	// because they have not aired yet (or only just started). Anime scope,
	// season folders and fully matched listings only.
	Upcoming []anilist.Media `json:"upcoming,omitempty"`
	// Missing: series of that season already on air for longer than the
	// grace period that the folder still lacks.
	Missing []anilist.Media `json:"missing,omitempty"`
	// Elsewhere: upcoming/missing media id -> a folder on the same server
	// that holds it or its direct prequel, outside this season folder. A
	// continuation after a break is often filed under its first season.
	Elsewhere map[int]string `json:"elsewhere,omitempty"`
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
//	@Failure		409		{object}	HostKeyConflict	"SSH host key unknown or changed"
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
			writeDialErr(w, err)
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
	matchable := s.scopeMatchable(scope)
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
				if item.Kind == "" {
					item.Kind = kindFromStat(st)
				}
			}
		}
		if scope == "" || isShelf(e.Name) || isHelperDir(e.Name) {
			// no metadata source chosen for this path yet: show the plain
			// structure and wait for the user to pick one (persisted mark).
			// An alphabet shelf is structure too, its titles are one deeper.
			items = append(items, item)
			continue
		}
		itemScope := scopeForItem(scope, item.Kind)
		var mediaID, manual int
		var rowSource string
		err := s.DB.QueryRow(`SELECT media_id, manual, source FROM catalog_matches
			WHERE server_id = ? AND folder = ?`, serverID, e.Path).Scan(&mediaID, &manual, &rowSource)
		// under an automatic mark the folder's source is the one its match
		// has: the scope names no provider
		itemSource := expectedSource(itemScope, rowSource)
		item.Source = itemSource
		if !matchable {
			// matching is switched off for this provider: what is stored is
			// shown, nothing is looked up, nothing is pending
			if err == nil && mediaID != 0 {
				item.Source = rowSource
				item.Media, item.Pending = s.sourceMedia(rowSource, mediaID)
			}
			items = append(items, item)
			continue
		}
		switch {
		case err == nil && manual == 1 && mediaID != 0 && rowSource != itemSource:
			// the user matched this folder against another provider than its
			// scope's (a pasted link, a TMDB hint taken in an AniList folder):
			// it stays what they chose and shows as that
			item.Source = rowSource
			item.Media, item.Pending = s.sourceMedia(rowSource, mediaID)
		case err != nil || rowSource != itemSource:
			// an identically named folder elsewhere (another server, or the
			// local copy of what was synced from one) already resolved to a
			// media entry - adopt it instead of searching for the same name
			// again
			if id, ok := s.reuseMatch(serverID, e.Name, itemSource); ok {
				// persistMatch logs a failure; the next listing adopts it again
				_ = s.persistMatch(serverID, e.Path, id, false, itemSource)
				item.Media, item.Pending = s.sourceMedia(itemSource, id)
				break
			}
			// local library: adopt Plex's tvdb/tmdb id (ground truth) to skip the
			// title search when the show is already known
			if serverID == localServerID {
				if id, ok := s.matchLocalByPlexID(e.Path, itemSource); ok {
					_ = s.persistMatch(serverID, e.Path, id, false, itemSource) // logged; retried next listing
					item.Media, item.Pending = s.sourceMedia(itemSource, id)
					break
				}
			}
			// never looked up, or the folder's scope changed since the match
			// was stored: match in the background, show the folder now
			item.Pending = true
			s.queueScopedMatch(serverID, e.Path, e.Name, itemScope, false)
		case mediaID == 0 && manual == 0:
			// searched before, nothing found: display "no match" but retry
			// quietly (search cache makes this cheap); manual unmatch is final
			s.queueScopedMatch(serverID, e.Path, e.Name, itemScope, false)
			if manual == 0 && itemSource == "anilist" {
				item.Hint = s.hintFor(serverID, e.Path)
			}
		case mediaID != 0:
			item.Media, item.Pending = s.sourceMedia(itemSource, mediaID)
		}
		items = append(items, item)
	}
	resp := catalogResponse{Scope: scope, Items: items, MatchingOff: scope != "" && !matchable}
	resp.Upcoming, resp.Missing = s.upcomingFor(r.Context(), dir, scope, items)
	resp.Elsewhere = s.elsewhereFor(r.Context(), serverID, append(resp.Upcoming, resp.Missing...))
	writeJSON(w, http.StatusOK, resp)
}

// upcomingGrace is how long after its start a series still counts as coming
// rather than missing: release groups lag behind the broadcast, sometimes by
// days, and start dates slip.
const upcomingGrace = 14 * 24 * time.Hour

// upcomingFor lists the season's series that a season folder ("2026-4 Fall")
// doesn't hold: still to come, and on air but missing. Empty while matches are pending (a fresh match would show
// up as missing), outside the anime scope, and when AniList is unreachable:
// the catalog itself must never wait on or fail over this extra.
func (s *Server) upcomingFor(ctx context.Context, dir, scope string, items []catalogItem) (upcoming, missing []anilist.Media) {
	season, year := seasonFromPath(path.Base(dir))
	if season == "" || scope != "anime" {
		return nil, nil
	}
	have := map[int]bool{}
	for _, it := range items {
		if it.Pending {
			return nil, nil
		}
		if it.Media != nil && it.Source == "anilist" {
			have[it.Media.ID] = true
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	list, err := s.Anilist.Season(ctx, season, year)
	if err != nil {
		slog.Debug("upcoming season", "season", season, "year", year, "err", err)
		return nil, nil
	}
	return upcomingOf(list, have, time.Now())
}

// elsewhereFor finds, per series, a folder on the same server that is matched
// to it or to its direct prequel/parent. Only a folder outside the listing can
// match: the listing's own matches were filtered out already. Relations come
// from cache or a batched lookup; what a slow AniList doesn't answer within
// the budget simply stays unknown until the next visit.
func (s *Server) elsewhereFor(ctx context.Context, serverID int64, list []anilist.Media) map[int]string {
	if len(list) == 0 {
		return nil
	}
	ids := make([]int, len(list))
	for i, m := range list {
		ids[i] = m.ID
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	rels, err := s.Anilist.RelationsBatch(ctx, ids)
	if err != nil {
		slog.Debug("upcoming relations", "err", err)
	}
	out := map[int]string{}
	for _, id := range ids {
		cands := []int{id}
		for _, r := range rels[id] {
			if r.RelationType == "PREQUEL" || r.RelationType == "PARENT" {
				cands = append(cands, r.Node.ID)
			}
		}
		for _, c := range cands {
			// several folders: the latest season folder sorts last
			var folder string
			if s.DB.QueryRow(`SELECT folder FROM catalog_matches
				WHERE server_id = ? AND source = 'anilist' AND media_id = ?
				ORDER BY folder DESC LIMIT 1`, serverID, c).Scan(&folder) == nil {
				out[id] = folder
				break
			}
		}
	}
	return out
}

// upcomingOf sorts the series (TV, TV short, ONA) not in have into those yet
// to start or started within upcomingGrace, and those on air for longer.
func upcomingOf(list []anilist.Media, have map[int]bool, now time.Time) (upcoming, missing []anilist.Media) {
	cutoff := now.Add(-upcomingGrace)
	since := anilist.Date(cutoff.Year(), int(cutoff.Month()), cutoff.Day())
	for _, m := range list {
		// the season list also carries films, specials and music videos,
		// which a season folder of series never holds
		if have[m.ID] || (m.Format != "TV" && m.Format != "TV_SHORT" && m.Format != "ONA") {
			continue
		}
		m.Title.Preferred = displayTitle(m, "anilist")
		switch {
		case m.Status == "NOT_YET_RELEASED",
			// a start without a day can't be told fresh: on air, so missing
			m.Status == "RELEASING" && m.StartDate%100 != 0 && m.StartDate >= since:
			upcoming = append(upcoming, m)
		case m.Status == "RELEASING":
			missing = append(missing, m)
		}
	}
	return upcoming, missing
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
		if rows.Scan(&id) != nil {
			return 0, false
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		return 0, false // a partial read can make an ambiguous match look unique
	}
	if len(ids) != 1 {
		return 0, false
	}
	return ids[0], true
}

// queueScopedMatch dispatches folder matching to the scope's metadata source.
func (s *Server) queueScopedMatch(serverID int64, folder, name, scope string, force bool) {
	if !s.scopeMatchable(scope) {
		return // the scope's provider is switched off for matching
	}
	// local library: try Plex's authoritative tvdb/tmdb id first (also drains
	// the sweep this way); an explicit rematch (force) still does a title search
	if serverID == localServerID && !force && scope != "manga" {
		// an automatic mark asks Plex only for the AniList mapping (sourceForScope):
		// a TVDB or TMDB id would be taken for the right provider without evidence
		src := sourceForScope(scope)
		if id, ok := s.matchLocalByPlexID(folder, src); ok {
			_ = s.persistMatch(serverID, folder, id, false, src) // logged; the sweep tries again
			return
		}
	}
	if scope == scopeAuto {
		s.queueAutoMatch(serverID, folder, name, force)
		return
	}
	if scope == "" || scope == "anime" || scope == "manga" {
		s.queueMatch(serverID, folder, name, force, scope == "manga")
		return
	}
	if scope == "tvdb" {
		s.queueTvdbMatch(serverID, folder, name, force)
		return
	}
	if scope == tvdbMovieSource {
		s.queueTvdbMovieMatch(serverID, folder, name)
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
	if localCurateDenied(w, u, serverID) {
		return
	}
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
	if len(in.Path) > 1 {
		in.Path = strings.TrimSuffix(in.Path, "/") // "/plex/Serien/" names the same folder
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
	// films inside a tv scope carry the movie source, so both tags qualify
	// every source a folder under an automatic mark may have been matched on
	src1, src2 := sourceForScope(scope), sourceForScope(scopeForItem(scope, "movie"))
	if scope == scopeAuto {
		src1, src2 = "anilist", "tmdb:tv"
	}
	rows, err := s.DB.Query(`SELECT folder FROM catalog_matches
		WHERE server_id = ?1 AND manual = 0 AND (source IN (?2, ?3) OR (?4 AND source IN ('tmdb:movie', 'tvdb', 'tvdb:movie'))) `+cond+`
		AND folder >= ?5 AND folder < ?6`,
		serverID, src1, src2, scope == scopeAuto,
		strings.TrimRight(in.Path, "/")+"/", strings.TrimRight(in.Path, "/")+"0")
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	var folders []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			dbErr(w)
			return
		}
		if strings.Contains(f[len(strings.TrimRight(in.Path, "/"))+1:], "/") {
			continue // the range holds the whole subtree; only direct children count
		}
		folders = append(folders, f)
	}
	if rows.Err() != nil {
		dbErr(w)
		return
	}
	for _, f := range folders {
		name := path.Base(f)
		s.queueScopedMatch(serverID, f, name, scopeForItem(scope, s.itemKind(serverID, f, name)), true)
		// drop the row so the catalog shows these as pending while the
		// forced search runs (poll picks the fresh result up)
		// a row that stays is replaced by the forced search's result anyway
		_, _ = s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ? AND folder = ? AND manual = 0`, serverID, f)
	}
	// plus what the source has not matched at all yet: a folder never
	// listed, or one still on the source the mark replaced
	queued := len(folders) + s.queueScopeChildren(serverID, in.Path, scope)
	writeJSON(w, http.StatusOK, rematchResponse{Queued: queued})
}

// queueScopeChildren queues a match for every folder directly under a marked
// one that the mark's source has not matched yet: no row, or a row of another
// source - a manual one included, since a changed mark is a choice against
// it. Reads the remote index, so a folder nobody has listed in the catalog is
// matched now rather than on the next sweep. Reports how many were queued.
func (s *Server) queueScopeChildren(serverID int64, dir, scope string) int {
	if scope == "" || serverID == localServerID {
		return 0 // the local library has no index; its listing matches
	}
	rows, err := s.DB.Query(`SELECT ri.path, ri.name, COALESCE(cm.source, ''), COALESCE(cm.media_id, 0), COALESCE(cm.manual, 0)
		FROM remote_index ri
		LEFT JOIN catalog_matches cm ON cm.server_id = ri.server_id AND cm.folder = ri.path
		WHERE ri.server_id = ? AND ri.is_dir = 1 AND ri.parent = ?`, serverID, dir)
	if err != nil {
		return 0
	}
	defer rows.Close()
	type child struct {
		path, name, source string
		mediaID, manual    int
	}
	var kids []child
	for rows.Next() {
		var c child
		if rows.Scan(&c.path, &c.name, &c.source, &c.mediaID, &c.manual) == nil {
			kids = append(kids, c)
		}
	}
	if rows.Err() != nil {
		return 0 // half a listing: queue nothing now, the next sweep covers it
	}
	queued := 0
	for _, c := range kids {
		if isShelf(c.name) || isHelperDir(c.name) {
			continue
		}
		itemScope := scopeForItem(scope, s.itemKind(serverID, c.path, c.name))
		if scope == scopeAuto {
			// the mark names no provider, so no match is on the wrong one:
			// only the folders with none are asked, and a manual match,
			// unmatch included, is the user's
			if c.manual == 1 || c.mediaID != 0 {
				continue
			}
		} else if c.source == sourceForScope(itemScope) {
			continue
		}
		s.queueScopedMatch(serverID, c.path, c.name, itemScope, c.source != "")
		queued++
	}
	return queued
}

// catalogMatchRequest is the body of handleCatalogMatch.
type catalogMatchRequest struct {
	Folder  string `json:"folder"`
	MediaID int    `json:"mediaId"` // 0 = unmatch
	// the provider of a pasted link or id from another source than the
	// folder's ("anilist" for an anime in a TVDB-ordered tree); empty: the
	// folder's own
	Source string `json:"source,omitempty"`
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
//	@Failure		500		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/servers/{id}/catalog/match [put]
func (s *Server) handleCatalogMatch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID := pathID(r)
	if localCurateDenied(w, u, serverID) {
		return
	}
	var in catalogMatchRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.Folder == "" || path.Clean(in.Folder) != in.Folder {
		writeErr(w, http.StatusBadRequest, "invalid folder")
		return
	}
	// ownership check: the server must belong to the user. The local pseudo
	// server has no row to own, same as in handleCatalogRematch and the scope
	// handlers - without this branch correcting a local match 404s.
	if serverID != localServerID {
		var owned int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM servers WHERE id = ? AND user_id = ?`, serverID, u.ID).Scan(&owned); err != nil {
			dbErr(w)
			return
		}
		if owned == 0 {
			writeErr(w, http.StatusNotFound, "server not found")
			return
		}
	}
	// the same source the folder is matched on everywhere (the mark on its
	// parent, else the library its auto-sync writes into); a link from
	// another provider says so itself
	source := s.folderSource(serverID, in.Folder)
	switch in.Source {
	case "":
	case "anilist", mangaSource, "tmdb:tv", "tmdb:movie", "tvdb", tvdbMovieSource:
		source = in.Source
	default:
		writeErr(w, http.StatusBadRequest, "invalid source")
		return
	}
	// the record first, so the series takes its name and kind with this
	// request rather than on a later pass; a provider that does not answer
	// leaves that to the sweep
	if in.MediaID > 0 {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		s.fetchMedia(ctx, source, in.MediaID)
		cancel()
	}
	if s.persistMatch(serverID, in.Folder, in.MediaID, true, source) != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// fetchMedia loads one record of any source into the cache, errors ignored.
func (s *Server) fetchMedia(ctx context.Context, source string, id int) {
	switch {
	case source == "anilist" || source == mangaSource:
		s.Anilist.Media(ctx, id)
	case source == "tvdb" && s.Tvdb != nil:
		s.Tvdb.Media(ctx, id)
	case source == tvdbMovieSource && s.Tvdb != nil:
		s.Tvdb.Movie(ctx, id)
	case strings.HasPrefix(source, "tmdb:") && s.Tmdb != nil:
		s.Tmdb.Media(ctx, strings.TrimPrefix(source, "tmdb:"), id)
	}
}

// localCurateDenied refuses a change to the local library's catalog (matches,
// sources, rules) to anyone but an admin: that library is everyone's, a
// remote server's catalog belongs to whoever added the server.
func localCurateDenied(w http.ResponseWriter, u *auth.User, serverID int64) bool {
	if serverID == localServerID && !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "admin only")
		return true
	}
	return false
}
