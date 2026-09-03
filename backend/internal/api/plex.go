package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/tvdb"
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
	t := secret.SettingOrEnv(s.DB, "plex_token", "PLEX_TOKEN")
	if u == "" || t == "" {
		return nil
	}
	return plex.New(u, t)
}

// plexMeResponse is the connection status shown on the settings page.
type plexMeResponse struct {
	Configured bool   `json:"configured"`
	Connected  bool   `json:"connected"`
	Username   string `json:"username,omitempty"` // linked plex.tv account
	Server     string `json:"server,omitempty"`   // friendly name of the server
	Version    string `json:"version,omitempty"`
	Error      string `json:"error,omitempty"`
}

// handlePlexMe reports whether the stored URL/token reach a Plex server, and
// which one. Always 200: an unreachable server is a status, not a failure.
//
//	@Summary		Plex connection status
//	@Description	Report whether the configured Plex URL and token reach a server, including its name and the linked account.
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	plexMeResponse
//	@Security		CookieAuth
//	@Router			/api/plex/me [get]
func (s *Server) handlePlexMe(w http.ResponseWriter, r *http.Request) {
	c := s.plexClient()
	if c == nil {
		writeJSON(w, http.StatusOK, plexMeResponse{})
		return
	}
	id, err := c.Identity()
	if err != nil {
		writeJSON(w, http.StatusOK, plexMeResponse{Configured: true, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, plexMeResponse{Configured: true, Connected: true,
		Username: id.MyPlexUsername, Server: id.FriendlyName, Version: id.Version})
}

// handlePlexSections lists the show sections for the settings checkboxes.
//
//	@Summary		Plex sections
//	@Description	List the Plex show and movie library sections for the settings checkboxes.
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}		plex.Section
//	@Failure		400	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/plex/sections [get]
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

// sourceAnilistTvdb is the combined library source: AniList stays the metadata
// provider (covers, sequel chains, episode counts), TVDB supplies the aired
// season mapping endless series need. Per watch that pairing is already legal;
// this is the library-level preselection for it.
const sourceAnilistTvdb = "anilist+tvdb"

// DefaultSectionSource is the preselected metadata source for a Plex library
// that has no stored choice. Anime keeps AniList; everything else follows the
// catalog Plex itself uses (from the library's episode ordering, falling back
// to the agent name). An anime library ordered by TVDB gets the combined
// source, so the aired mapping is prepared without losing AniList's chains.
func DefaultSectionSource(sec plex.Section) string {
	anime := strings.Contains(strings.ToLower(sec.Title), "anime")
	switch {
	// the aired mapping is a series concern, so films stay on plain AniList
	case anime && sec.Provider == "tvdb" && sec.Type == "show":
		return sourceAnilistTvdb
	case anime:
		return "anilist"
	case sec.Type == "movie":
		return "tmdb" // TVDB has no movies here, see tvdbTVSuggestions
	case sec.Provider != "":
		return sec.Provider
	}
	return "tmdb"
}

// sectionKind records POSITIVE anime evidence for a Plex library and nothing
// else: kindAnime, or "" for undecided. It is never "this is not anime".
//
// The metadata source is not the signal it looks like. Plex has never heard of
// AniList, an anime library is normally scanned and ordered by TVDB, and the
// user picks that source accordingly - so reading "source == anilist" as the
// anime marker would miss most anime libraries. Hence the explicit per-library
// choice (plex_section_anime) decides, and only where the user has not made one
// do the title, the AniDB-backed legacy agents and the source stand in for it.
//
// A tvdb- or tmdb-ordered library stays undecided on purpose. Claiming
// live_action there is what would delete an anime film's suggestions out of a
// library the user simply called "Filme".
func sectionKind(sec plex.Section, explicit, src string) string {
	switch explicit {
	case "1":
		return kindAnime
	case "0":
		return ""
	}
	if src == "" {
		src = DefaultSectionSource(sec)
	}
	agent := strings.ToLower(sec.Agent)
	if strings.HasPrefix(src, "anilist") ||
		strings.Contains(strings.ToLower(sec.Title), "anime") ||
		strings.Contains(agent, "hama") || strings.Contains(agent, "anidb") {
		return kindAnime
	}
	return ""
}

// sectionSources / sectionAnime read the two per-library settings into
// section-key maps. Both store "key:value" pairs and a missing key means "not
// chosen", which is why the maps are handed around instead of a resolved value:
// only the reader knows what the fallback for its section is.
func (s *Server) sectionSources() map[string]string { return s.sectionSetting("plex_section_sources") }
func (s *Server) sectionAnime() map[string]string   { return s.sectionSetting("plex_section_anime") }

func (s *Server) sectionSetting(key string) map[string]string {
	out := map[string]string{}
	for kv := range strings.SplitSeq(db.Setting(s.DB, key), ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(kv), ":"); ok && k != "" {
			out[k] = v
		}
	}
	return out
}

type plexSuggestion struct {
	ShowTitle string        `json:"showTitle"`
	Year      int           `json:"year"`
	LeafCount int           `json:"leafCount"`
	Folder    string        `json:"folder"`         // Plex storage folder of the show
	Library   string        `json:"library"`        // Plex library (section) title, for grouping
	Kind      string        `json:"kind,omitempty"` // that library's kind: "anime" or "" (undecided), for categorising
	Sequel    anilist.Media `json:"sequel"`
	ChainNeed int           `json:"chainNeed"`        // episodes through the sequel
	Source    string        `json:"source,omitempty"` // "" = anilist, else tmdb:tv | tmdb:movie | tvdb
	// AiredMapping: the library pairs AniList metadata with TVDB's aired
	// season mapping, so a watch created from this suggestion starts with it
	AiredMapping bool            `json:"airedMapping,omitempty"`
	TVDBID       int             `json:"tvdbId,omitempty"` // series id for the rename profile
	Candidates   []plexCandidate `json:"candidates"`
}

type plexCandidate struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
}

// plexSuggestionsResponse is the cached Plex suggestion list plus its build state.
type plexSuggestionsResponse struct {
	Configured  bool             `json:"configured"`
	Building    bool             `json:"building"` // a background rebuild is in progress
	Suggestions []plexSuggestion `json:"suggestions"`
}

// handlePlexSuggestions serves the cached suggestion list and triggers a
// background rebuild when stale (or ?force=1). Remote candidates are
// resolved per requesting user at read time.
//
//	@Summary		Plex suggestions
//	@Description	Missing-sequel suggestions derived from the user's Plex libraries, with remote folder candidates.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			force	query		string	false	"Set to 1 to force a rebuild"
//	@Success		200		{object}	plexSuggestionsResponse
//	@Security		CookieAuth
//	@Router			/api/plex/suggestions [get]
func (s *Server) handlePlexSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if s.plexClient() == nil {
		writeJSON(w, http.StatusOK, plexSuggestionsResponse{Configured: false, Building: false, Suggestions: []plexSuggestion{}})
		return
	}
	force := r.URL.Query().Get("force") == "1"
	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = 'plex:suggestions:v3'`).Scan(&payload, &fetched)
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
	writeJSON(w, http.StatusOK, plexSuggestionsResponse{Configured: true, Building: building, Suggestions: suggestions})
}

// remoteCandidates searches the requesting user's remote index for folders
// matching the sequel title (romaji, then english), max 3.
//
// A title search alone offers a film for a series and a series for a film, so a
// folder the sweep has ALREADY classified as the other form is dropped. Only
// that: a folder with no variant row still passes, because remote_index carries
// no type of its own and an empty candidate list reads as "not available" to
// every caller - failing closed would quietly empty the watchlist instead.
//
// ponytail: the form gate is one-directional and only for a format that says
// unambiguously what it is. OVA/ONA/SPECIAL and an empty format filter nothing;
// guessing "not a film" for them would drop every film folder from an OVA's
// candidates. There is deliberately no anime gate here either - deriveSeriesKind
// calls an anime matched only through tvdb/tmdb live_action, so it would delete
// real candidates.
func (s *Server) remoteCandidates(userID int64, m anilist.Media) []plexCandidate {
	wrongForm := -1 // is_movie value this media can never be; -1 = do not filter
	switch m.Format {
	case "MOVIE":
		wrongForm = 0
	case "TV", "TV_SHORT":
		wrongForm = 1
	}
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
		if wrongForm >= 0 {
			// hits the catalog_variants primary key (server_id, folder)
			q.WriteString(` AND NOT EXISTS (SELECT 1 FROM catalog_variants cv
				WHERE cv.server_id = i.server_id AND cv.folder = i.path
				  AND cv.show_key != '' AND cv.is_movie = ?)`)
			args = append(args, wrongForm)
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
	srcOf, animeOf := s.sectionSources(), s.sectionAnime()
	sourceOf := func(sec plex.Section) string {
		v, ok := srcOf[sec.Key]
		if !ok {
			v = DefaultSectionSource(sec)
		}
		// ponytail: TVDB is series-only here - Plex never carries a tvdb guid
		// for movies and TVDB has no collections, so there is nothing to
		// suggest. A movie library set to tvdb falls back to TMDB.
		if (v == "tvdb" || v == sourceAnilistTvdb) && sec.Type == "movie" {
			if v == sourceAnilistTvdb {
				return "anilist"
			}
			return "tmdb"
		}
		return v
	}

	var shows []plex.Show            // anime → AniList matching
	isMovie := map[string]bool{}     // ratingKey → item lives in a movie library
	libOf := map[string]string{}     // ratingKey → library (section) title, for grouping
	kindOfLib := map[string]string{} // library title → its kind, stamped on every suggestion below
	// ratingKey → the library wants TVDB aired mapping alongside AniList
	airedLib := map[string]bool{}
	var liveTV, liveMovies, tvdbShows []plex.Show
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
		kindOfLib[sec.Title] = sectionKind(sec, animeOf[sec.Key], srcOf[sec.Key])
		src := sourceOf(sec)
		if src == sourceAnilistTvdb {
			for _, sh := range list {
				airedLib[sh.RatingKey] = true
			}
		}
		switch {
		case src == "tvdb":
			tvdbShows = append(tvdbShows, list...)
		case src == "tmdb" && sec.Type == "movie":
			liveMovies = append(liveMovies, list...)
		case src == "tmdb":
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
			// The two directions of the same mistake. A film's title usually
			// also matches its parent series, and a series' title usually also
			// matches the film that was cut from it - so each library keeps the
			// first hit whose format it can actually hold. Rooting a series on a
			// film matters twice over: the chain then walks film sequels, and
			// the episode arithmetic counts the film as one episode.
			want := func(m anilist.Media) bool { return m.Format == "MOVIE" }
			if !isMovie[sh.RatingKey] {
				want = func(m anilist.Media) bool { return m.Format != "MOVIE" }
			}
			for _, m := range list {
				if want(m) {
					pick = m
					break
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
			// deadline/rate hit mid-resolution: keep the sequels found so far
			// and build suggestions with them; the next poll fills the rest
			slog.Warn("plex relations", "err", err)
			break
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
			Library: libOf[sh.RatingKey], Sequel: *sequel, ChainNeed: cum,
			AiredMapping: airedLib[sh.RatingKey]}
		// the detail carries the guid array the bulk listing omits, so the
		// series id for the rename profile comes from here
		if detail, err := c.ShowDetail(sh.RatingKey); err == nil {
			if len(detail.Locations) > 0 {
				sug.Folder = detail.Locations[0]
			}
			if sug.AiredMapping {
				sug.TVDBID = detail.TVDBID
			}
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
	// libraries explicitly set to TVDB
	if len(tvdbShows) > 0 {
		if s.Tvdb.Enabled() {
			suggestions = append(suggestions, s.tvdbTVSuggestions(ctx, c, tvdbShows, libOf)...)
		} else {
			slog.Warn("plex tvdb sections skipped: no TVDB key configured")
		}
	}

	// stamp the library's kind on every suggestion, whichever builder made it.
	// Keyed by the library title the builders already carry, so their three
	// signatures stay as they are.
	for i := range suggestions {
		suggestions[i].Kind = kindOfLib[suggestions[i].Library]
	}

	payload, _ := json.Marshal(suggestions)
	s.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES ('plex:suggestions:v3', ?, datetime('now'))
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

// plexTitleIndex maps normalized titles of the Plex libraries to their
// ratingKey. One round of cheap listings, cached for an hour. Movies are in
// here as much as series are: a film the library holds is just as owned as a
// show, and leaving the movie sections out is what let them come back as
// suggestions. The key carries a version because the cached payload of the
// shows-only build is indistinguishable from a complete one.
func (s *Server) plexTitleIndex(c *plex.Client) map[string]string {
	idx := map[string]string{}
	if p, ok := s.cacheGet("plex:titleidx:v2", time.Hour); ok {
		json.Unmarshal([]byte(p), &idx)
		return idx
	}
	sections, err := c.Sections()
	if err != nil {
		return idx
	}
	for _, sec := range sections {
		if sec.Type != "show" && sec.Type != "movie" {
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
	s.cacheSet("plex:titleidx:v2", string(p))
	return idx
}

// plexOwned answers "does the library already hold this?" for a whole round of
// suggestions. Two lookups, because neither alone is enough: the guid index
// carries the provider ids Plex assigned (the only reliable match for a
// TMDB-sourced title, which two catalogues rarely spell alike), and the title
// index covers the entries Plex has no ids for at all.
func (s *Server) plexOwned() func(m anilist.Media, source string) bool {
	c := s.plexClient()
	if c == nil {
		// Plex unconfigured: nothing is owned, so nothing gets hidden
		return func(anilist.Media, string) bool { return false }
	}
	titles := s.plexTitleIndex(c)
	tmdb := map[int]bool{}
	for _, g := range s.plexGuidIndex() {
		if g.TMDB > 0 {
			tmdb[g.TMDB] = true
		}
	}
	return func(m anilist.Media, source string) bool {
		if src, _, _ := strings.Cut(source, ":"); src == "tmdb" && tmdb[m.ID] {
			return true
		}
		for _, t := range []string{m.Title.Romaji, m.Title.English, m.Title.Native} {
			if t != "" && titles[normTitle(t)] != "" {
				return true
			}
		}
		return false
	}
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
	return s.plexLinkFor(c, key)
}

// plexLinkFor assembles the app.plex.tv deep link for a library ratingKey.
func (s *Server) plexLinkFor(c *plex.Client, key string) string {
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

// plexWebLinkByKey resolves the deep link from what the series knows about
// itself, falling back to the title index only when the series has no provider
// id Plex shares.
func (s *Server) plexWebLinkByKey(showKey string, titles ...string) string {
	c := s.plexClient()
	if c == nil {
		return s.plexWebLink(titles...)
	}
	if rk := s.plexRatingKeyResolve(showKey); rk != "" {
		if l := s.plexLinkFor(c, rk); l != "" {
			return l
		}
	}
	return s.plexWebLink(titles...)
}

// plexRatingKeyResolve gives the series' CURRENT address in Plex. The live guid
// index outranks the stored provider row, because a ratingKey is a row id in
// Plex's own metadata db, not an identity: rebuild an item and it comes back
// under a new key, leaving the stored row pointing at whatever occupies the old
// slot today. The stored row therefore only carries when Plex is unreachable
// and the index comes back empty.
// A stored row the library contradicts is dropped on the spot. Nothing else
// ever invalidates it, so a wrong binding - a renumbered show, or a title match
// that once landed on the wrong item - would otherwise stand forever.
func (s *Server) plexRatingKeyResolve(showKey string) string {
	if showKey == "" {
		return ""
	}
	stored, manual := s.plexRatingKeyFor(showKey)
	if manual {
		return stored // a person decided this; nothing here overrules it
	}
	live := guidRatingKey(s.plexGuidIndex(), showKey)
	if live == "" {
		return stored // Plex unreachable: a stale address still beats none
	}
	if stored != "" && stored != live {
		s.DB.Exec(`DELETE FROM series_provider WHERE source = 'plex' AND media_id = ? AND manual = 0`, stored)
		slog.Info("plex ratingKey reissued", "showKey", logSafe(showKey), "was", stored, "now", live)
	}
	return live
}

// plexRatingKeyFor looks up Plex's own id for the series behind a show_key, via
// the provider row reconcilePlex writes. Empty when the show_key does not
// resolve to a series, or that series has no plex row yet.
// manual reports whether that row was set by hand, which puts it beyond the
// reach of every automatic pass.
func (s *Server) plexRatingKeyFor(showKey string) (rk string, manual bool) {
	src, idStr, ok := strings.Cut(showKey, ":")
	if !ok {
		return "", false
	}
	id, err := strconv.Atoi(idStr)
	if err != nil || id <= 0 {
		return "", false
	}
	if src == "tmdb" {
		src = "tmdb:tv" // show_key drops the kind; tv is what a series carries
	}
	var key int
	// a series can end up with two plex rows (library rebuilt, show split and
	// re-added); the hand-picked one wins, otherwise pick deterministically
	if s.DB.QueryRow(`SELECT p.media_id, p.manual FROM series_provider p
		JOIN series_provider q ON q.series_id = p.series_id
		WHERE p.source = 'plex' AND q.source = ? AND q.media_id = ?
		ORDER BY p.manual DESC, p.media_id`, src, id).Scan(&key, &manual) != nil {
		return "", false
	}
	return strconv.Itoa(key), manual
}

// guidRatingKey finds the ratingKey whose Plex guid carries the show_key's
// provider id.
func guidRatingKey(idx map[string]plexGuid, showKey string) string {
	g, _ := guidForShowKey(idx, showKey)
	return g.RatingKey
}

// guidForShowKey finds the Plex show whose guid carries the show_key's provider
// id. ponytail: linear scan, the index holds one entry per library show.
func guidForShowKey(idx map[string]plexGuid, showKey string) (plexGuid, bool) {
	if showKey == "" {
		return plexGuid{}, false
	}
	for _, g := range idx {
		if g.RatingKey == "" {
			continue
		}
		if (g.TVDB != 0 && showKey == "tvdb:"+strconv.Itoa(g.TVDB)) ||
			(g.TMDB != 0 && showKey == "tmdb:"+strconv.Itoa(g.TMDB)) ||
			(g.IMDB != 0 && showKey == "imdb:"+strconv.Itoa(g.IMDB)) {
			return g, true
		}
	}
	return plexGuid{}, false
}

// attachPlexIdentity hangs the provider identity of one Plex show on a series,
// and folds in whatever series already claims those ids so a show ends up as one
// entry no matter which catalog first named it.
//
// exact says the binding is the folder Plex itself scanned rather than a folded
// title. Only then may a conflicting id be merged: a merge cannot be undone, and
// the title route demonstrably lands on the wrong show - it once bound a series
// to an unrelated film whose title folded to the same key.
func (s *Server) attachPlexIdentity(seriesID int64, g plexGuid, exact bool) {
	rk, _ := strconv.Atoi(g.RatingKey)
	// imdb only ever comes from Plex (suggestion badge, extra dedup axis); the
	// plex row is its own address, needed for deep links and stream selection
	for _, r := range []providerRef{{"tvdb", g.TVDB}, {"tmdb:tv", g.TMDB}, {"imdb", g.IMDB}, {"plex", rk}} {
		if r.MediaID <= 0 {
			continue
		}
		if other := s.seriesByProvider(r.Source, r.MediaID); other != 0 && other != seriesID {
			if !exact {
				// INSERT OR IGNORE would drop this silently; say so instead
				slog.Debug("plex identity claimed elsewhere", "seriesId", seriesID,
					"other", other, "source", r.Source, "mediaId", r.MediaID)
				continue
			}
			s.mergeSeries(other, seriesID)
		}
		s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES (?, ?, ?)`,
			r.Source, r.MediaID, seriesID)
	}
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
// episodes than Plex has - TMDB models seasons inside one entry, so there is
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

// airedEpisodes counts a series' regular, already-aired episodes: season 0
// (specials) and unaired entries don't belong in a completeness check.
func airedEpisodes(eps []tvdb.Episode, now time.Time) int {
	n := 0
	for _, e := range eps {
		if e.SeasonNumber <= 0 || e.Aired == "" {
			continue
		}
		d, err := time.Parse("2006-01-02", e.Aired)
		if err != nil || d.After(now) {
			continue
		}
		n++
	}
	return n
}

// tvdbTVSuggestions: a show in a TVDB-sourced library is "incomplete" when
// TVDB lists more aired episodes than Plex has. Like TMDB, TVDB models
// seasons inside one entry, so there is no sequel chain to walk.
func (s *Server) tvdbTVSuggestions(ctx context.Context, c *plex.Client, shows []plex.Show, libOf map[string]string) []plexSuggestion {
	var out []plexSuggestion
	now := time.Now()
	for _, sh := range shows {
		if ctx.Err() != nil {
			return out
		}
		// the bulk listing carries no guid array, so the authoritative id comes
		// from the show detail; the title search is only the last resort
		detail, derr := c.ShowDetail(sh.RatingKey)
		id := sh.TVDBID
		if id == 0 && derr == nil {
			id = detail.TVDBID
		}
		if id == 0 {
			hits, err := s.Tvdb.SearchMedia(ctx, sh.Title)
			if err != nil || len(hits) == 0 {
				continue
			}
			id = hits[0].ID
		}
		eps, err := s.Tvdb.Episodes(ctx, id, "official")
		if err != nil {
			continue
		}
		aired := airedEpisodes(eps, now)
		if aired <= sh.LeafCount {
			continue
		}
		m, err := s.Tvdb.Media(ctx, id)
		if err != nil {
			continue
		}
		sug := plexSuggestion{ShowTitle: sh.Title, Year: sh.Year, LeafCount: sh.LeafCount,
			Library: libOf[sh.RatingKey], Sequel: *m, ChainNeed: aired, Source: "tvdb",
			AiredMapping: true, TVDBID: id}
		if derr == nil && len(detail.Locations) > 0 {
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
			// Plex titles may be localized or original - accept either
			if have[normTitle(p.Title.Romaji)] || have[normTitle(p.Title.English)] {
				continue
			}
			out = append(out, plexSuggestion{ShowTitle: mv.Title, Year: mv.Year, LeafCount: 1,
				Library: libOf[mv.RatingKey], Sequel: p, ChainNeed: len(parts), Source: "tmdb:movie"})
		}
	}
	return out
}
