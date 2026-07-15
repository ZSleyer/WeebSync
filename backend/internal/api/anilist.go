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
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/nssteinbrenner/anitogo"
)

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
	Entry remote.Entry   `json:"entry"`
	Media *anilist.Media `json:"media,omitempty"`
	// Pending: metadata is being resolved in the background, poll again
	Pending bool `json:"pending,omitempty"`
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
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
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
	// search → alternative title from parens ("Romaji (English)" folders)
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
	for i, b := range batch {
		mediaID := 0
		if len(results[i]) > 0 {
			mediaID = results[i][0].ID
			s.Anilist.CacheMedia(&results[i][0])
		}
		s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual) VALUES (?, ?, ?, 0)`,
			b.serverID, b.folder, mediaID)
	}
}

// queueMediaFetch refreshes missing/stale media metadata in the background.
func (s *Server) queueMediaFetch(id int) {
	s.runJob(fmt.Sprintf("f:%d", id), func(ctx context.Context) {
		s.Anilist.Media(ctx, id) // stores into the cache on success
	})
}

var (
	bracketRe = regexp.MustCompile(`\[[^\]]*\]`)
	parenRe   = regexp.MustCompile(`\([^)]*\)`)
)

// GuessTitle extracts a searchable series title from a release folder/file
// name. anitogo handles release-style filenames; folder names in the wild
// look like "Romaji Titel (English Title) [GerDub,CR]", where the bracket
// tags and the alternative title in parens ruin the search, so both are
// stripped afterwards.
func GuessTitle(name string) string {
	parsed := anitogo.Parse(name, anitogo.DefaultOptions)
	t := parsed.AnimeTitle
	if t == "" {
		t = name
	}
	t = bracketRe.ReplaceAllString(t, " ")
	t = parenRe.ReplaceAllString(t, " ")
	if t = strings.Join(strings.Fields(t), " "); t != "" {
		return t
	}
	return strings.TrimSpace(name)
}

// GuessAltTitle returns the alternative title from a parenthesized group
// ("Romaji (English) [Tags]" → "English"), used as a search fallback.
func GuessAltTitle(name string) string {
	for _, m := range parenRe.FindAllString(bracketRe.ReplaceAllString(name, " "), -1) {
		alt := strings.Trim(m, "() ")
		if len(strings.Fields(alt)) >= 2 { // "(2022)", "(Ko)" are no titles
			return alt
		}
	}
	return ""
}

// handleCatalog lists remote folders enriched with AniList metadata. The
// structure is returned immediately; unmatched folders are resolved by
// background jobs and flagged pending so the client polls until done.
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	client, rootPath, err := s.DialServer(u.ID, serverID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer client.Close()
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = rootPath
	}
	entries, err := client.List(dir)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	items := []catalogItem{}
	for _, e := range entries {
		if !e.IsDir {
			continue
		}
		item := catalogItem{Entry: e}
		var mediaID, manual int
		err := s.DB.QueryRow(`SELECT media_id, manual FROM catalog_matches
			WHERE server_id = ? AND folder = ?`, serverID, e.Path).Scan(&mediaID, &manual)
		switch {
		case err != nil:
			// never looked up: match in the background, show the folder now
			item.Pending = true
			s.queueMatch(serverID, e.Path, e.Name, false)
		case mediaID == 0 && manual == 0:
			// searched before, nothing found: display "no match" but retry
			// quietly (search cache makes this cheap); manual unmatch is final
			s.queueMatch(serverID, e.Path, e.Name, false)
		case mediaID != 0:
			m, fresh := s.Anilist.CachedMedia(mediaID)
			item.Media = m
			switch {
			case m == nil:
				item.Pending = true
				s.queueMediaFetch(mediaID)
			case !fresh && m.Status != "FINISHED" && m.Status != "CANCELLED":
				// airing/upcoming titles change (episodes, score): refresh
				// quietly in the background; finished ones never do
				s.queueMediaFetch(mediaID)
			}
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

// handleCatalogRematch re-queues automatic matches directly under the given
// path with a forced (cache-bypassing) search: by default only "no match"
// folders, with all=true every automatic match. Manual matches/unmatches
// (manual=1) are always left alone.
func (s *Server) handleCatalogRematch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in struct {
		Path string `json:"path"`
		All  bool   `json:"all"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	// ownership check doubles as root path lookup (empty path = root)
	var rootPath string
	if err := s.DB.QueryRow(`SELECT root_path FROM servers WHERE id = ? AND user_id = ?`,
		serverID, u.ID).Scan(&rootPath); err != nil {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	if in.Path == "" {
		in.Path = rootPath
	}
	if in.Path == "" || path.Clean(in.Path) != in.Path {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	// direct children only: no second slash after the prefix
	cond := "AND media_id = 0"
	if in.All {
		cond = ""
	}
	rows, err := s.DB.Query(`SELECT folder FROM catalog_matches
		WHERE server_id = ? AND manual = 0 `+cond+`
		AND folder LIKE ? || '/%' AND folder NOT LIKE ? || '/%/%'`,
		serverID, in.Path, in.Path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
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
		s.queueMatch(serverID, f, path.Base(f), true)
		// drop the row so the catalog shows these as pending while the
		// forced search runs (poll picks the fresh result up)
		s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ? AND folder = ? AND manual = 0`, serverID, f)
	}
	writeJSON(w, http.StatusOK, map[string]int{"queued": len(folders)})
}

// handleCatalogMatch sets or clears a manual folder→media match.
func (s *Server) handleCatalogMatch(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	serverID, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in struct {
		Folder  string `json:"folder"`
		MediaID int    `json:"mediaId"` // 0 = unmatch
	}
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
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual) VALUES (?, ?, ?, 1)`,
		serverID, in.Folder, in.MediaID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
