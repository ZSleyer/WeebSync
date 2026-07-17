package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/plex"
)

// Plex integration: read the user's Plex show libraries, match shows against
// AniList and suggest missing sequels, including the Plex storage folder (to
// keep a series in one place) and remote folder candidates from the index.

// plexSuggestTTL is the suggestions-cache lifetime: the ttl_plex_h setting
// in hours, default 6.
func (s *Server) plexSuggestTTL() time.Duration {
	return s.ttlSetting("ttl_plex_h", 6*time.Hour)
}

func (s *Server) plexClient() *plex.Client {
	u := db.SettingOrEnv(s.DB, "plex_url", "PLEX_URL")
	t := db.SettingOrEnv(s.DB, "plex_token", "PLEX_TOKEN")
	if u == "" || t == "" {
		return nil
	}
	return plex.New(u, t)
}

// handlePlexSections lists the show sections for the settings checkboxes.
func (s *Server) handlePlexSections(w http.ResponseWriter, r *http.Request) {
	c := s.plexClient()
	if c == nil {
		writeErr(w, http.StatusBadRequest, "plex not configured")
		return
	}
	sections, err := c.Sections()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	out := []plex.Section{}
	for _, sec := range sections {
		if sec.Type == "show" || sec.Type == "movie" {
			out = append(out, sec)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type plexSuggestion struct {
	ShowTitle  string          `json:"showTitle"`
	Year       int             `json:"year"`
	LeafCount  int             `json:"leafCount"`
	Folder     string          `json:"folder"`  // Plex storage folder of the show
	Library    string          `json:"library"` // Plex library (section) title, for grouping
	Sequel     anilist.Media   `json:"sequel"`
	ChainNeed  int             `json:"chainNeed"`        // episodes through the sequel
	Source     string          `json:"source,omitempty"` // "" = anilist, else tmdb:tv | tmdb:movie
	Candidates []plexCandidate `json:"candidates"`
}

type plexCandidate struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
}

// handlePlexSuggestions serves the cached suggestion list and triggers a
// background rebuild when stale (or ?force=1). Remote candidates are
// resolved per requesting user at read time.
func (s *Server) handlePlexSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if s.plexClient() == nil {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false, "building": false, "suggestions": []plexSuggestion{}})
		return
	}
	force := r.URL.Query().Get("force") == "1"
	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = 'plex:suggestions:v2'`).Scan(&payload, &fetched)
	fresh := false
	if t, err := time.Parse(sqliteTime, fetched); err == nil {
		fresh = time.Since(t) <= s.plexSuggestTTL()
	}
	building := false
	if payload == "" || !fresh || force {
		building = true
		s.runJob("plex:suggest", func(ctx context.Context) { s.buildPlexSuggestions(ctx) })
	}
	var suggestions []plexSuggestion
	json.Unmarshal([]byte(payload), &suggestions)
	if suggestions == nil {
		suggestions = []plexSuggestion{}
	}
	for i := range suggestions {
		suggestions[i].Candidates = s.remoteCandidates(u.ID, suggestions[i].Sequel)
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "building": building, "suggestions": suggestions})
}

// remoteCandidates searches the requesting user's remote index for folders
// matching the sequel title (romaji, then english), max 3.
func (s *Server) remoteCandidates(userID int64, m anilist.Media) []plexCandidate {
	out := []plexCandidate{}
	seen := map[string]bool{}
	for _, title := range []string{m.Title.Romaji, m.Title.English} {
		words := significantWords(title, 3)
		if len(words) == 0 {
			continue
		}
		var q strings.Builder
		q.WriteString(`SELECT i.server_id, s.name, i.path FROM remote_index i
			JOIN servers s ON s.id = i.server_id AND s.user_id = ?
			WHERE i.is_dir = 1`)
		args := []any{userID}
		for _, wd := range words {
			q.WriteString(` AND i.name LIKE '%' || ? || '%' COLLATE NOCASE`)
			args = append(args, wd)
		}
		q.WriteString(` LIMIT 3`)
		rows, err := s.DB.Query(q.String(), args...)
		if err != nil {
			continue
		}
		for rows.Next() {
			var c plexCandidate
			rows.Scan(&c.ServerID, &c.ServerName, &c.Path)
			if !seen[c.Path] && len(out) < 3 {
				seen[c.Path] = true
				out = append(out, c)
			}
		}
		rows.Close()
		if len(out) >= 3 {
			break
		}
	}
	return out
}

// significantWords picks up to n search-worthy words (len >= 3) of a title.
func significantWords(title string, n int) []string {
	var out []string
	for _, wd := range strings.FieldsFunc(title, func(r rune) bool {
		return !('a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9')
	}) {
		if len(wd) >= 3 {
			out = append(out, wd)
			if len(out) == n {
				break
			}
		}
	}
	return out
}

// sequelFormats: chain steps we count as "the series continues". Movie
// libraries walk their own chain of MOVIE sequels instead.
var sequelFormats = map[string]bool{"TV": true, "TV_SHORT": true, "ONA": true}
var movieFormats = map[string]bool{"MOVIE": true}

// walkChain follows SEQUEL edges (restricted to formats) from base, one step
// per relations wave the caller resolved. Returns the chain including base.
func walkChain(base anilist.Media, rels map[int][]anilist.Relation, formats map[string]bool) []anilist.Media {
	chain := []anilist.Media{base}
	cur := base
	for range [8]int{} { // safety bound
		var next *anilist.Media
		for _, r := range rels[cur.ID] {
			if r.RelationType == "SEQUEL" && formats[r.Node.Format] && r.Node.Status != "NOT_YET_RELEASED" {
				n := r.Node
				next = &n
				break
			}
		}
		if next == nil {
			break
		}
		chain = append(chain, *next)
		cur = *next
	}
	return chain
}

// missingSequel finds the first chain entry whose cumulative episode count
// exceeds what Plex has. Unknown episode counts (still airing) count as 1.
func missingSequel(chain []anilist.Media, leaf int) (*anilist.Media, int) {
	cum := 0
	for i, m := range chain {
		eps := m.Episodes
		if eps <= 0 {
			eps = 1
		}
		cum += eps
		if i > 0 && leaf < cum {
			return &chain[i], cum
		}
	}
	return nil, 0
}

// buildPlexSuggestions recomputes the suggestion list: Plex shows → AniList
// matches (batched, cached) → relation chains → missing sequels + folders.
// Partial progress persists in the AniList cache, so a timed-out first run
// completes on the next poll.
func (s *Server) buildPlexSuggestions(ctx context.Context) {
	c := s.plexClient()
	if c == nil {
		return
	}
	sections, err := c.Sections()
	if err != nil {
		slog.Warn("plex sections", "err", err)
		return
	}
	wanted := map[string]bool{}
	for k := range strings.SplitSeq(db.Setting(s.DB, "plex_sections"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			wanted[k] = true
		}
	}
	// per-section metadata source: explicit key:source entries from the
	// settings; a section without an entry falls back to its library title
	// ("anime" in the name → AniList, otherwise TMDB)
	srcOf := map[string]string{}
	for kv := range strings.SplitSeq(db.Setting(s.DB, "plex_section_sources"), ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(kv), ":"); ok && k != "" {
			srcOf[k] = v
		}
	}
	isAnime := func(sec plex.Section) bool {
		if v, ok := srcOf[sec.Key]; ok {
			return v == "anilist"
		}
		return strings.Contains(strings.ToLower(sec.Title), "anime")
	}

	var shows []plex.Show        // anime → AniList matching
	isMovie := map[string]bool{} // ratingKey → item lives in a movie library
	libOf := map[string]string{} // ratingKey → library (section) title, for grouping
	var liveTV, liveMovies []plex.Show
	for _, sec := range sections {
		if (sec.Type != "show" && sec.Type != "movie") || (len(wanted) > 0 && !wanted[sec.Key]) {
			continue
		}
		list, err := c.Shows(sec.Key)
		if err != nil {
			slog.Warn("plex shows", "section", sec.Key, "err", err)
			continue
		}
		for _, sh := range list {
			libOf[sh.RatingKey] = sec.Title
		}
		switch {
		case !isAnime(sec) && sec.Type == "movie":
			liveMovies = append(liveMovies, list...)
		case !isAnime(sec):
			liveTV = append(liveTV, list...)
		case sec.Type == "movie":
			for _, sh := range list {
				isMovie[sh.RatingKey] = true
			}
			shows = append(shows, list...)
		default:
			shows = append(shows, list...)
		}
	}

	// match shows against AniList in batches; the response cache makes
	// repeat runs nearly free
	matched := map[string]anilist.Media{} // ratingKey → media
	for start := 0; start < len(shows); start += 10 {
		if ctx.Err() != nil {
			return
		}
		end := min(start+10, len(shows))
		reqs := make([]anilist.SearchReq, 0, 10)
		for _, sh := range shows[start:end] {
			reqs = append(reqs, anilist.SearchReq{Query: sh.Title})
		}
		results, err := s.Anilist.SearchBatch(ctx, reqs)
		if err != nil {
			slog.Warn("plex anilist match", "err", err)
			return
		}
		for i, list := range results {
			if len(list) == 0 {
				continue
			}
			sh := shows[start+i]
			pick := list[0]
			// a movie title often also matches its parent TV series —
			// prefer the first MOVIE-format result for movie libraries
			if isMovie[sh.RatingKey] {
				for _, m := range list {
					if m.Format == "MOVIE" {
						pick = m
						break
					}
				}
			}
			matched[sh.RatingKey] = pick
		}
	}

	// resolve relation chains in waves (S1 → S2 → S3 ...)
	rels := map[int][]anilist.Relation{}
	need := map[int]bool{}
	for _, m := range matched {
		need[m.ID] = true
	}
	for range [4]int{} {
		var ids []int
		for id := range need {
			if _, ok := rels[id]; !ok {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			break
		}
		got, err := s.Anilist.RelationsBatch(ctx, ids)
		if err != nil {
			slog.Warn("plex relations", "err", err)
			return
		}
		for id, r := range got {
			rels[id] = r
			for _, e := range r {
				if e.RelationType == "SEQUEL" && (sequelFormats[e.Node.Format] || movieFormats[e.Node.Format]) {
					need[e.Node.ID] = true
				}
			}
		}
	}

	var suggestions []plexSuggestion
	for _, sh := range shows {
		m, ok := matched[sh.RatingKey]
		if !ok {
			continue
		}
		formats, leaf := sequelFormats, sh.LeafCount
		if isMovie[sh.RatingKey] {
			formats, leaf = movieFormats, 1 // the movie itself counts as present
		}
		chain := walkChain(m, rels, formats)
		sequel, cum := missingSequel(chain, leaf)
		if sequel == nil {
			continue
		}
		sug := plexSuggestion{ShowTitle: sh.Title, Year: sh.Year, LeafCount: leaf,
			Library: libOf[sh.RatingKey], Sequel: *sequel, ChainNeed: cum}
		if detail, err := c.ShowDetail(sh.RatingKey); err == nil && len(detail.Locations) > 0 {
			sug.Folder = detail.Locations[0]
		}
		suggestions = append(suggestions, sug)
	}
	// live-action sections go through TMDB instead of AniList
	if s.Tmdb.Enabled() {
		suggestions = append(suggestions, s.liveTVSuggestions(ctx, c, liveTV, libOf)...)
		suggestions = append(suggestions, s.liveMovieSuggestions(ctx, liveMovies, libOf)...)
	} else if len(liveTV)+len(liveMovies) > 0 {
		slog.Warn("plex live-action sections skipped: no TMDB key configured")
	}

	payload, _ := json.Marshal(suggestions)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('plex:suggestions:v2', ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`, string(payload))
	slog.Info("plex suggestions built", "shows", len(shows), "matched", len(matched),
		"liveTV", len(liveTV), "liveMovies", len(liveMovies), "suggestions", len(suggestions))
}

// normTitle folds case and whitespace for title-presence checks.
func normTitle(t string) string {
	return strings.ToLower(strings.Join(strings.Fields(t), " "))
}

// cacheGet/cacheSet: small KV helpers on the shared anilist_cache table.
func (s *Server) cacheGet(key string, maxAge time.Duration) (string, bool) {
	var payload, fetched string
	if err := s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).
		Scan(&payload, &fetched); err != nil {
		return "", false
	}
	t, err := time.Parse(sqliteTime, fetched)
	if err != nil || time.Since(t) > maxAge {
		return "", false
	}
	return payload, true
}

func (s *Server) cacheSet(key, payload string) {
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`, key, payload)
}

// plexTitleIndex maps normalized titles of the Plex show libraries to their
// ratingKey. One round of cheap listings, cached for an hour.
func (s *Server) plexTitleIndex(c *plex.Client) map[string]string {
	idx := map[string]string{}
	if p, ok := s.cacheGet("plex:titleidx", time.Hour); ok {
		json.Unmarshal([]byte(p), &idx)
		return idx
	}
	sections, err := c.Sections()
	if err != nil {
		return idx
	}
	for _, sec := range sections {
		if sec.Type != "show" {
			continue
		}
		shows, err := c.Shows(sec.Key)
		if err != nil {
			continue
		}
		for _, sh := range shows {
			idx[normTitle(sh.Title)] = sh.RatingKey
			if sh.OriginalTitle != "" {
				idx[normTitle(sh.OriginalTitle)] = sh.RatingKey
			}
		}
	}
	p, _ := json.Marshal(idx)
	s.cacheSet("plex:titleidx", string(p))
	return idx
}

// plexWebLink returns the app.plex.tv deep link to a library entry matching
// one of the given titles; "" when Plex is unconfigured or has no match.
// app.plex.tv works from anywhere (local URLs often don't).
func (s *Server) plexWebLink(titles ...string) string {
	c := s.plexClient()
	if c == nil {
		return ""
	}
	idx := s.plexTitleIndex(c)
	key := ""
	for _, t := range titles {
		if t == "" {
			continue
		}
		if k, ok := idx[normTitle(t)]; ok {
			key = k
			break
		}
	}
	if key == "" {
		return ""
	}
	mid, ok := s.cacheGet("plex:machineid", 24*time.Hour)
	if !ok {
		var err error
		if mid, err = c.MachineID(); err != nil || mid == "" {
			return ""
		}
		s.cacheSet("plex:machineid", mid)
	}
	return "https://app.plex.tv/desktop/#!/server/" + mid + "/details?key=" + url.QueryEscape("/library/metadata/"+key)
}

// plexFolderNames maps media ids to the Plex folder basename of the same
// title, so watchlist syncs can reuse the existing Plex naming. Best effort:
// nil when Plex is not configured; title matching via normTitle. The title
// index is one round of cheap listings (cached 1h); folder locations are
// fetched once per matched show (cached 24h).
func (s *Server) plexFolderNames(medias []anilist.Media) map[int]string {
	c := s.plexClient()
	if c == nil || len(medias) == 0 {
		return nil
	}
	idx := s.plexTitleIndex(c)
	out := map[int]string{}
	for _, m := range medias {
		key, ok := idx[normTitle(m.Title.Romaji)]
		if !ok {
			key, ok = idx[normTitle(m.Title.English)]
		}
		if !ok {
			continue
		}
		ck := "plex:loc:" + key
		folder, cached := s.cacheGet(ck, 24*time.Hour)
		if !cached {
			if detail, err := c.ShowDetail(key); err == nil && len(detail.Locations) > 0 {
				folder = path.Base(detail.Locations[0])
				s.cacheSet(ck, folder)
			}
		}
		if folder != "" {
			out[m.ID] = folder
		}
	}
	return out
}

// liveTVSuggestions: a non-anime show is "incomplete" when TMDB knows more
// episodes than Plex has — TMDB models seasons inside one entry, so there is
// no sequel chain to walk.
func (s *Server) liveTVSuggestions(ctx context.Context, c *plex.Client, shows []plex.Show, libOf map[string]string) []plexSuggestion {
	var out []plexSuggestion
	for _, sh := range shows {
		if ctx.Err() != nil {
			return out
		}
		list, err := s.Tmdb.Search(ctx, "tv", sh.Title, sh.Year)
		if err != nil || len(list) == 0 {
			list, err = s.Tmdb.Search(ctx, "tv", sh.Title, 0)
		}
		if err != nil || len(list) == 0 {
			continue
		}
		m, err := s.Tmdb.Media(ctx, "tv", list[0].ID) // details carry the episode count
		if err != nil || m.Episodes <= sh.LeafCount || m.Status == "NOT_YET_RELEASED" {
			continue
		}
		sug := plexSuggestion{ShowTitle: sh.Title, Year: sh.Year, LeafCount: sh.LeafCount,
			Library: libOf[sh.RatingKey], Sequel: *m, ChainNeed: m.Episodes, Source: "tmdb:tv"}
		if detail, err := c.ShowDetail(sh.RatingKey); err == nil && len(detail.Locations) > 0 {
			sug.Folder = detail.Locations[0]
		}
		out = append(out, sug)
	}
	return out
}

// liveMovieSuggestions: for each movie that belongs to a TMDB collection,
// suggest the released parts missing from the library.
func (s *Server) liveMovieSuggestions(ctx context.Context, movies []plex.Show, libOf map[string]string) []plexSuggestion {
	have := map[string]bool{}
	for _, mv := range movies {
		have[normTitle(mv.Title)] = true
	}
	var out []plexSuggestion
	seenColl := map[int]bool{}
	for _, mv := range movies {
		if ctx.Err() != nil {
			return out
		}
		list, err := s.Tmdb.Search(ctx, "movie", mv.Title, mv.Year)
		if err != nil || len(list) == 0 {
			list, err = s.Tmdb.Search(ctx, "movie", mv.Title, 0)
		}
		if err != nil || len(list) == 0 {
			continue
		}
		collID, err := s.Tmdb.MovieCollection(ctx, list[0].ID)
		if err != nil || collID == 0 || seenColl[collID] {
			continue
		}
		seenColl[collID] = true
		parts, err := s.Tmdb.Collection(ctx, collID)
		if err != nil {
			continue
		}
		for _, p := range parts {
			// Plex titles may be localized or original — accept either
			if have[normTitle(p.Title.Romaji)] || have[normTitle(p.Title.English)] {
				continue
			}
			out = append(out, plexSuggestion{ShowTitle: mv.Title, Year: mv.Year, LeafCount: 1,
				Library: libOf[mv.RatingKey], Sequel: p, ChainNeed: len(parts), Source: "tmdb:movie"})
		}
	}
	return out
}
