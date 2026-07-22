package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// ProviderLinks are the per-integration title pages for a suggestion.
type ProviderLinks struct {
	Anilist string `json:"anilist,omitempty"`
	Tmdb    string `json:"tmdb,omitempty"`
	Tvdb    string `json:"tvdb,omitempty"`
	Imdb    string `json:"imdb,omitempty"`
	Plex    string `json:"plex,omitempty"`
}

// SugItem is one deduplicated suggestion: a single series regardless of how many
// providers surfaced it, carrying which integrations recognise it (Providers),
// links to each, a series-wide ignore key, and the server folders it maps to.
type SugItem struct {
	RefKey     string          `json:"refKey"`   // series:{id} | fold:{key}:{year}
	SeriesID   int64           `json:"seriesId"` // 0 when not bundled yet
	Category   string          `json:"category"` // anime-movie | anime-tv | movie | tv
	Title      string          `json:"title"`
	Year       int             `json:"year,omitempty"`
	Cover      string          `json:"cover,omitempty"`
	Media      anilist.Media   `json:"media"`
	Providers  []string        `json:"providers"`
	Links      ProviderLinks   `json:"links"`
	Candidates []plexCandidate `json:"candidates"`

	Status     string         `json:"status,omitempty"`   // watchlist: CURRENT|PLANNING|COMPLETED
	Progress   int            `json:"progress,omitempty"` // watchlist
	Have       int            `json:"have,omitempty"`     // incomplete: episodes present
	Need       int            `json:"need,omitempty"`     // incomplete: episodes through sequel
	Sequel     *anilist.Media `json:"sequel,omitempty"`   // incomplete
	PlexFolder string         `json:"plexFolder,omitempty"`
	ShowKey    string         `json:"showKey,omitempty"` // incomplete (missing unit): canonical unit
	Season     int            `json:"season,omitempty"`
	IsMovie    bool           `json:"isMovie,omitempty"`
	Library    string         `json:"library,omitempty"` // incomplete: Plex library title, for grouping
	Sync       SyncPlan       `json:"sync,omitempty"`    // incomplete (missing unit): where a one-off sync creates the season/movie folder
}

// SuggestionsResponse is the unified payload: one list per functional bucket.
type SuggestionsResponse struct {
	Watchlist  []SugItem           `json:"watchlist"`
	Trending   []SugItem           `json:"trending"`
	Upgrades   []UpgradeSuggestion `json:"upgrades"`
	Incomplete []SugItem           `json:"incomplete"`
	Building   bool                `json:"building"`
}

type providerRef struct {
	Source  string
	MediaID int
}

// seriesProviderMaps scans series_provider once into two lookup maps:
// (source,media_id)->series_id and series_id->provider hits. Cheap: the table
// is small and this avoids a query per suggestion.
func (s *Server) seriesProviderMaps() (bySrc map[string]int64, bySeries map[int64][]providerRef) {
	bySrc, bySeries = map[string]int64{}, map[int64][]providerRef{}
	rows, err := s.DB.Query(`SELECT source, media_id, series_id FROM series_provider`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var src string
		var mid int
		var sid int64
		if rows.Scan(&src, &mid, &sid) != nil {
			continue
		}
		bySrc[src+"|"+strconv.Itoa(mid)] = sid
		bySeries[sid] = append(bySeries[sid], providerRef{src, mid})
	}
	return
}

// sugAcc deduplicates suggestions by RefKey within one bucket, unioning the
// providers/links/candidates and keeping the richest media.
type sugAcc struct {
	byKey map[string]*SugItem
	order []string
}

func newAcc() *sugAcc { return &sugAcc{byKey: map[string]*SugItem{}} }

func (a *sugAcc) add(it SugItem) {
	if it.RefKey == "" || it.Title == "" {
		return
	}
	ex, ok := a.byKey[it.RefKey]
	if !ok {
		cp := it
		a.byKey[it.RefKey] = &cp
		a.order = append(a.order, it.RefKey)
		return
	}
	// union providers + links
	for _, p := range it.Providers {
		if !slices.Contains(ex.Providers, p) {
			ex.Providers = append(ex.Providers, p)
		}
	}
	slices.Sort(ex.Providers)
	mergeLinks(&ex.Links, it.Links)
	// union candidates (dedup server+path)
	for _, c := range it.Candidates {
		if !slices.ContainsFunc(ex.Candidates, func(x plexCandidate) bool { return x.ServerID == c.ServerID && x.Path == c.Path }) {
			ex.Candidates = append(ex.Candidates, c)
		}
	}
	// richer media wins (cover + episode count)
	if betterMedia(it.Media, ex.Media) {
		ex.Media, ex.Cover = it.Media, it.Cover
	}
	if ex.Status == "" {
		ex.Status, ex.Progress = it.Status, it.Progress
	}
	if ex.PlexFolder == "" {
		ex.PlexFolder = it.PlexFolder
	}
}

func (a *sugAcc) list(dismissed map[string]bool) []SugItem {
	out := []SugItem{}
	for _, k := range a.order {
		if dismissed[k] {
			continue
		}
		out = append(out, *a.byKey[k])
	}
	return out
}

func mergeLinks(dst *ProviderLinks, src ProviderLinks) {
	if dst.Anilist == "" {
		dst.Anilist = src.Anilist
	}
	if dst.Tmdb == "" {
		dst.Tmdb = src.Tmdb
	}
	if dst.Tvdb == "" {
		dst.Tvdb = src.Tvdb
	}
	if dst.Imdb == "" {
		dst.Imdb = src.Imdb
	}
	if dst.Plex == "" {
		dst.Plex = src.Plex
	}
}

func betterMedia(a, b anilist.Media) bool {
	score := func(m anilist.Media) int {
		n := 0
		if m.CoverImage.Large != "" {
			n += 2
		}
		if m.Episodes > 0 {
			n++
		}
		return n
	}
	return score(a) > score(b)
}

// hasCJK reports whether s contains Japanese/Chinese script (kana or CJK
// ideographs, plus fullwidth forms), i.e. a native title we never want to show.
func hasCJK(s string) bool {
	for _, r := range s {
		if (r >= 0x3040 && r <= 0x30ff) || // hiragana + katakana
			(r >= 0x3400 && r <= 0x9fff) || // CJK ideographs
			(r >= 0xf900 && r <= 0xfaff) || // CJK compat ideographs
			(r >= 0xff00 && r <= 0xffef) { // fullwidth/halfwidth forms
			return true
		}
	}
	return false
}

// displayTitle picks a localized, non-Japanese title. TMDB stores the localized
// name in Romaji (original in English), AniList the romanized name in Romaji and
// the localized one in English - so the preference order differs by source. In
// both cases a title containing native script (kana/kanji) is skipped; only if
// every candidate is native (nothing latinized exists) is one shown as a last
// resort.
func displayTitle(m anilist.Media, source string) string {
	cands := []string{m.Title.English, m.Title.Romaji} // AniList: English first
	if strings.HasPrefix(source, "tmdb") {
		cands = []string{m.Title.Romaji, m.Title.English} // TMDB: localized (Romaji) first
	}
	for _, c := range cands {
		if c != "" && !hasCJK(c) {
			return c
		}
	}
	for _, c := range cands {
		if c != "" {
			return c
		}
	}
	return ""
}

// dedupIncomplete drops sequel-chain items (no show_key) whose show is already
// covered by a per-season missing-unit (show_key set) - the same show otherwise
// appears twice in the incomplete bucket, once from each builder.
func dedupIncomplete(items []SugItem) []SugItem {
	covered := map[string]bool{}
	for _, it := range items {
		if it.ShowKey != "" {
			covered[match.FoldKey(match.StripMarkers(it.Title))] = true
		}
	}
	out := make([]SugItem, 0, len(items))
	for _, it := range items {
		if it.ShowKey == "" && covered[match.FoldKey(match.StripMarkers(it.Title))] {
			continue
		}
		out = append(out, it)
	}
	return out
}

// buildItem turns a raw provider suggestion into a deduplicated SugItem: it
// resolves the series bundle (for the ignore key + provider union), the badges
// and links, and the category.
func (s *Server) buildItem(m anilist.Media, source string, cands []plexCandidate, plexFolder string, bySrc map[string]int64, bySeries map[int64][]providerRef) SugItem {
	title := displayTitle(m, source) // localized display title
	m.Title.Preferred = title        // carry it on the media for the frontend
	// the fold key stays on the romanized title so it matches linkSeries' bundling
	foldTitle := m.Title.Romaji
	if foldTitle == "" {
		foldTitle = m.Title.English
	}
	seriesID := bySrc[source+"|"+strconv.Itoa(m.ID)]
	var refs []providerRef
	refKey := ""
	if seriesID != 0 {
		refKey = "series:" + strconv.FormatInt(seriesID, 10)
		refs = bySeries[seriesID]
	} else {
		refKey = "fold:" + match.FoldKey(match.StripMarkers(foldTitle)) + ":" + strconv.Itoa(m.SeasonYear)
		refs = []providerRef{{source, m.ID}}
	}
	providers, links := s.providerBadgesLinks(refs, title)
	return SugItem{
		RefKey: refKey, SeriesID: seriesID, Category: categorize(providers, m, source),
		Title: title, Year: m.SeasonYear, Cover: m.CoverImage.Large, Media: m,
		Providers: providers, Links: links, Candidates: cands, PlexFolder: plexFolder,
	}
}

// providerBadgesLinks turns provider hits into the badge set and per-integration
// title links. A Plex web link is added when the title is in a Plex library.
func (s *Server) providerBadgesLinks(refs []providerRef, title string) ([]string, ProviderLinks) {
	set := map[string]bool{}
	var l ProviderLinks
	for _, r := range refs {
		switch {
		case r.Source == "anilist", r.Source == sourceAnilistTvdb:
			set["anilist"] = true
			l.Anilist = fmt.Sprintf("https://anilist.co/anime/%d", r.MediaID)
			if r.Source == sourceAnilistTvdb {
				set["tvdb"] = true
			}
		case r.Source == "tmdb:tv":
			set["tmdb"] = true
			l.Tmdb = fmt.Sprintf("https://www.themoviedb.org/tv/%d", r.MediaID)
		case r.Source == "tmdb:movie":
			set["tmdb"] = true
			l.Tmdb = fmt.Sprintf("https://www.themoviedb.org/movie/%d", r.MediaID)
		case r.Source == "tvdb":
			set["tvdb"] = true
			l.Tvdb = fmt.Sprintf("https://thetvdb.com/dereferrer/series/%d", r.MediaID)
		case r.Source == "imdb":
			set["imdb"] = true
			l.Imdb = fmt.Sprintf("https://www.imdb.com/title/tt%d", r.MediaID)
		}
	}
	if pl := s.plexWebLink(title); pl != "" {
		set["plex"] = true
		l.Plex = pl
	}
	return keysSorted(set), l
}

// categorize sorts a suggestion into anime-movie|anime-tv|movie|tv. Anime when
// any provider is AniList or TVDB (TVDB is anime-only in this setup); live when
// only TMDB. Movie by the media format or a :movie source.
func categorize(providers []string, m anilist.Media, source string) string {
	// anime is decided by the providers (AniList/TVDB), not by an empty source:
	// the upgrade/incomplete builders pass source "" and rely on the badges, so
	// a "" must NOT force anime (that put live-action TMDB shows under Anime).
	anime := slices.Contains(providers, "anilist") || slices.Contains(providers, "tvdb") ||
		source == "anilist" || source == "tvdb"
	movie := m.Format == "MOVIE" || strings.HasSuffix(source, ":movie")
	base := "tv"
	if movie {
		base = "movie"
	}
	if anime {
		return "anime-" + base
	}
	// non-anime animation (Western cartoons): TMDB "Animation" genre. Split out
	// from live-action so the user's Animationsserien library gets its own block.
	for _, g := range m.Genres {
		if strings.EqualFold(g, "Animation") {
			return "animation-" + base
		}
	}
	return base
}

// handleSuggestions is the unified suggestion endpoint: it composes the three
// functional buckets from the existing provider builders (all cached), merges
// each provider's items per series, and filters the user's ignore list.
//
//	@Summary		Unified suggestions
//	@Description	Trending, watchlist and incomplete-series suggestions across all providers, deduplicated per series with provider badges and links.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			force	query		string	false	"Set to 1 to force provider rebuilds"
//	@Success		200		{object}	SuggestionsResponse
//	@Security		CookieAuth
//	@Router			/api/suggestions [get]
func (s *Server) handleSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	force := r.URL.Query().Get("force") == "1"

	// serve the pre-aggregated per-user blob instantly; rebuild in the
	// background when stale. The assembly (merge/dedup, remoteCandidates, the
	// live plex.tv call) is the slow part, so it never runs on the request path.
	key := fmt.Sprintf("suggestions:%d", u.ID)
	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).Scan(&payload, &fetched)
	fresh := false
	if t, err := time.Parse(sqliteTime, fetched); err == nil {
		fresh = time.Since(t) <= suggestTTL
	}
	building := false
	if payload == "" || !fresh || force {
		building = true
		uid := u.ID
		s.runJob(key, func(ctx context.Context) { s.buildUserSuggestions(ctx, uid) })
	}

	var resp SuggestionsResponse
	json.Unmarshal([]byte(payload), &resp)
	// dismiss is per-user and changes instantly, so filter at read time rather
	// than baking it into the cached blob (a dismiss needs no rebuild).
	dismissed := s.dismissedKeys(u.ID, "suggestion")
	resp.Trending = filterDismissed(resp.Trending, dismissed)
	resp.Watchlist = filterDismissed(resp.Watchlist, dismissed)
	resp.Incomplete = filterDismissed(resp.Incomplete, dismissed)
	upDismissed := s.dismissedKeys(u.ID, "upgrade")
	kept := make([]UpgradeSuggestion, 0, len(resp.Upgrades))
	for _, up := range resp.Upgrades {
		if !upDismissed[up.Key] {
			kept = append(kept, up)
		}
	}
	resp.Upgrades = kept
	resp.Building = building || payload == ""
	if resp.Trending == nil {
		resp.Trending = []SugItem{}
	}
	if resp.Watchlist == nil {
		resp.Watchlist = []SugItem{}
	}
	if resp.Incomplete == nil {
		resp.Incomplete = []SugItem{}
	}
	writeJSON(w, http.StatusOK, resp)
}

func filterDismissed(items []SugItem, dismissed map[string]bool) []SugItem {
	out := make([]SugItem, 0, len(items))
	for _, it := range items {
		if !dismissed[it.RefKey] {
			out = append(out, it)
		}
	}
	return out
}

// suggestTTL is how long a user's aggregated suggestion blob stays fresh before
// a background rebuild. The underlying provider data has its own longer TTLs.
const suggestTTL = 30 * time.Minute

// buildUserSuggestions assembles a user's three suggestion buckets from the
// (cached) provider builders and stores the merged result under
// suggestions:{userID}. This is the slow path - run in the background by the
// endpoint and the warm loop, never on the request. No dismiss filter: that is
// applied per-request at read time.
func (s *Server) buildUserSuggestions(ctx context.Context, userID int64) SuggestionsResponse {
	bySrc, bySeries := s.seriesProviderMaps()

	// ── Trending: AniList + TMDB discovery charts ──
	tr := newAcc()
	for _, a := range s.anilistTrending(ctx, userID) {
		tr.add(s.buildItem(a.Media, "anilist", a.Candidates, a.PlexFolder, bySrc, bySeries))
	}
	if s.Tmdb.Enabled() {
		for _, kind := range []string{"tv", "movie"} {
			if list, err := s.Tmdb.Trending(ctx, kind); err == nil {
				for _, t := range s.tmdbSuggestList(userID, kind, list, true) {
					tr.add(s.buildItem(t.Media, t.Source, t.Candidates, t.PlexFolder, bySrc, bySeries))
				}
			}
		}
	}

	// ── Watchlist: AniList + TMDB + plex.tv ──
	wl := newAcc()
	s.addAnilistWatchlist(userID, wl, bySrc, bySeries)
	if s.Tmdb.Enabled() {
		if accountID, session, err := s.tmdbAccount(userID); err == nil {
			for _, kind := range []string{"tv", "movie"} {
				ck := fmt.Sprintf("tmdb:watchlist:%d:%s", accountID, kind)
				var medias []anilist.Media
				if payload, ok := s.cacheGet(ck, time.Hour); ok {
					json.Unmarshal([]byte(payload), &medias)
				} else if medias, err = s.Tmdb.Watchlist(ctx, session, accountID, kind); err == nil {
					payload, _ := json.Marshal(medias)
					s.cacheSet(ck, string(payload))
				}
				for _, t := range s.tmdbSuggestList(userID, kind, medias, false) {
					wl.add(s.buildItem(t.Media, t.Source, t.Candidates, t.PlexFolder, bySrc, bySeries))
				}
			}
		}
	}
	for _, it := range s.plexWatchlistItems(userID, bySrc, bySeries) {
		wl.add(it)
	}

	// ── Incomplete: seasons/movies that exist REMOTE but are missing LOCAL
	// (Plex), plus the Plex missing-sequel chains ──
	inc := newAcc()
	s.addMissingUnits(inc)
	s.addIncomplete(userID, inc, bySrc, bySeries)

	resp := SuggestionsResponse{
		Watchlist:  wl.list(nil),
		Trending:   ownedFilter(tr.list(nil)), // trending is for NEW titles only
		Incomplete: dedupIncomplete(inc.list(nil)),
		Upgrades:   s.buildUpgrades(userID),
	}
	if b, err := json.Marshal(resp); err == nil {
		s.cacheSet(fmt.Sprintf("suggestions:%d", userID), string(b))
	}
	return resp
}

// ownedFilter drops trending items the user already has (present on a server or
// in Plex) so Trending only surfaces titles to discover.
func ownedFilter(items []SugItem) []SugItem {
	out := make([]SugItem, 0, len(items))
	for _, it := range items {
		if len(it.Candidates) > 0 || it.PlexFolder != "" {
			continue
		}
		out = append(out, it)
	}
	return out
}

// addAnilistWatchlist adds the user's CURRENT/PLANNING titles that exist on a
// server, refreshing the watchlist cache in the background when stale.
func (s *Server) addAnilistWatchlist(userID int64, acc *sugAcc, bySrc map[string]int64, bySeries map[int64][]providerRef) {
	alID, token, err := s.anilistAccount(userID)
	if err != nil {
		return
	}
	list := s.Anilist.CachedUserList(alID)
	var fetched string
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, fmt.Sprintf("alist:%d", alID)).Scan(&fetched)
	if t, perr := time.Parse(sqliteTime, fetched); perr != nil || time.Since(t) > time.Hour {
		s.buildAnilistSuggestions(alID, token)
	}
	for _, e := range list {
		// geplant (PLANNING), schaue ich (CURRENT), abgeschlossen (COMPLETED).
		// COMPLETED is carried so the UI can group it, but hidden by default and
		// never turned into a proactive suggestion (the frontend gates it).
		if e.Status != "CURRENT" && e.Status != "PLANNING" && e.Status != "COMPLETED" {
			continue
		}
		cands := s.remoteCandidates(userID, e.Media)
		if len(cands) == 0 {
			continue
		}
		it := s.buildItem(e.Media, "anilist", cands, "", bySrc, bySeries)
		it.Status, it.Progress = e.Status, e.Progress
		acc.add(it)
	}
}

// plexWatchlistItems converts the linked plex.tv watchlist into SugItems.
func (s *Server) plexWatchlistItems(userID int64, bySrc map[string]int64, bySeries map[int64][]providerRef) []SugItem {
	out := []SugItem{}
	token := s.plexAccountToken(userID)
	if token == "" {
		return out
	}
	resp, err := s.plexTVReq(http.MethodGet,
		"https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1", token)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	var body struct {
		MediaContainer struct {
			Metadata []struct {
				Title string `json:"title"`
				Year  int    `json:"year"`
				Type  string `json:"type"`
				Guid  []struct {
					ID string `json:"id"`
				} `json:"Guid"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return out
	}
	for _, m := range body.MediaContainer.Metadata {
		var tvdb, tmdb int
		for _, g := range m.Guid {
			if strings.HasPrefix(g.ID, "tvdb://") {
				tvdb = idFromGuidStr(g.ID)
			}
			if strings.HasPrefix(g.ID, "tmdb://") {
				tmdb = idFromGuidStr(g.ID)
			}
		}
		// pick the provider id we can map to a series; prefer tmdb
		media := anilist.Media{SeasonYear: m.Year, Format: "TV"}
		media.Title.Romaji = m.Title
		source := ""
		switch {
		case tmdb != 0:
			source = "tmdb:tv"
			if m.Type == "movie" {
				source, media.Format = "tmdb:movie", "MOVIE"
			}
			media.ID = tmdb
		case tvdb != 0:
			source = "tvdb"
			media.ID = tvdb
		default:
			continue // nothing to key on
		}
		out = append(out, s.buildItem(media, source, nil, "", bySrc, bySeries))
	}
	return out
}

// addIncomplete adds Plex missing-sequel suggestions, categorised by the sequel.
func (s *Server) addIncomplete(userID int64, acc *sugAcc, bySrc map[string]int64, bySeries map[int64][]providerRef) {
	if s.plexClient() == nil {
		return
	}
	var payload, fetched string
	s.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = 'plex:suggestions:v3'`).Scan(&payload, &fetched)
	fresh := false
	if t, err := time.Parse(sqliteTime, fetched); err == nil {
		fresh = time.Since(t) <= s.plexSuggestTTL()
	}
	if payload == "" || !fresh {
		s.runJob("plex:suggest", func(ctx context.Context) { s.buildPlexSuggestions(ctx) })
	}
	var sugg []plexSuggestion
	json.Unmarshal([]byte(payload), &sugg)
	for _, ps := range sugg {
		source := ps.Source
		if source == "" {
			source = "anilist"
		}
		it := s.buildItem(ps.Sequel, source, s.remoteCandidates(userID, ps.Sequel), "", bySrc, bySeries)
		it.Have, it.Need = ps.LeafCount, ps.ChainNeed
		seq := ps.Sequel
		seq.Title.Preferred = displayTitle(seq, source) // same localized title as the card
		it.Sequel = &seq
		acc.add(it)
	}
}
