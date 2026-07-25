package api

import (
	"context"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

// WatchEpisode is one episode as the metadata provider lists it, flagged with
// whether the watch's local folder holds it.
type WatchEpisode struct {
	Season   int    `json:"season"`             // the season the local files are filed under
	Episode  int    `json:"episode"`            // episode number within that season
	Absolute int    `json:"absolute,omitempty"` // the provider's absolute number, when it has one
	Local    int    `json:"local,omitempty"`    // local number, only when a {episode-N} template renumbers it
	Title    string `json:"title,omitempty"`
	Aired    string `json:"aired,omitempty"` // YYYY-MM-DD, "" when the provider has no date
	Have     bool   `json:"have"`
	Upcoming bool   `json:"upcoming,omitempty"` // dated in the future, so its absence is not a gap
}

// WatchEpisodesResponse is one watch's episode list. Episodes is never null:
// without a provider the numbers parsed from the local file names still explain
// the gap badge. Reason names the degradation so the UI can say why the titles
// are missing instead of looking broken.
type WatchEpisodesResponse struct {
	Provider string         `json:"provider,omitempty"` // tvdb | tmdb | "" when none resolved
	SeriesID int            `json:"seriesId,omitempty"`
	Title    string         `json:"title,omitempty"` // series title at the provider
	URL      string         `json:"url,omitempty"`   // series page at the provider
	Reason   string         `json:"reason,omitempty"`
	Missing  int            `json:"missing"` // episodes in the list the folder does not hold
	Episodes []WatchEpisode `json:"episodes"`
}

// provEpisode is one episode as any provider reports it, so the local-presence
// join does not care which one answered.
type provEpisode struct {
	Season   int
	Number   int
	Absolute int
	Title    string
	Aired    string
}

// watchProvider is the provider identity of a watched folder, as far as the
// episode list needs it.
type watchProvider struct {
	Name     string // tvdb | tmdb | "" when nothing resolves
	SeriesID int
	Ordering string // TVDB season type; TMDB ignores it
	Season   int    // the season this folder holds per folderUnit, 0 = unknown
}

// watchProviderFor resolves which provider series a watch belongs to.
// watchSeries carries the rename profile (Plex as the authority, the per-watch
// override on top) but deliberately holds no id for an AniList-matched folder -
// renaming is TVDB/TMDB only. folderUnit fills that in from the Fribb mapping,
// and is also the only place a folder's own season number comes from.
func (s *Server) watchProviderFor(wt Watch) watchProvider {
	ser := s.watchSeries(wt)
	key, season, isMovie := s.folderUnit(wt.ServerID, wt.RemotePath)
	if kind, idStr, ok := strings.Cut(key, ":"); ok && !isMovie {
		if id, _ := strconv.Atoi(idStr); id > 0 {
			if kind == "tvdb" && ser.TVDBID == 0 {
				ser.TVDBID = id
			}
			if kind == "tmdb" && ser.TMDBTVID == 0 {
				ser.TMDBTVID = id
			}
		}
	}
	p := watchProvider{Ordering: ser.Ordering, Season: season}
	// the configured provider first, then whichever one actually has an id: a
	// provider without an id shows nothing, the other may show everything.
	// Mirrors airmap's tvdb-before-tmdb default.
	for _, name := range []string{ser.Provider, "tvdb", "tmdb"} {
		id, on := ser.TVDBID, s.Tvdb != nil && s.Tvdb.Enabled()
		if name == "tmdb" {
			id, on = ser.TMDBTVID, s.Tmdb != nil && s.Tmdb.Enabled()
		}
		if name != "" && on && id != 0 {
			p.Name, p.SeriesID = name, id
			break
		}
	}
	// TVDB's season types are official|dvd|absolute. "aired" is TMDB's word for
	// the same thing and would 404 on /series/{id}/episodes/aired.
	if p.Name == "tvdb" && (p.Ordering == "" || p.Ordering == "aired") {
		p.Ordering = "official"
	}
	return p
}

// gapSeasons returns the seasons whose local numbering has a hole - exactly the
// seasons the gap badge counts, because the modal is that badge's detail view.
// Listing anything else would show episodes the badge never complained about,
// and a 34-season library would be unreadable in one dialog. When nothing has a
// gap (someone called the endpoint directly), the highest local season keeps
// the list from being empty.
func gapSeasons(nums map[int]bool) []int {
	// missingEpisodes already defines what a gap is; re-deriving it here would
	// be a second definition free to drift from the badge.
	bySeason := map[int]map[int]bool{}
	for k := range nums {
		se, _ := splitEpKey(k)
		if se == 0 {
			continue // season 0 = specials, inherently sparse
		}
		if bySeason[se] == nil {
			bySeason[se] = map[int]bool{}
		}
		bySeason[se][k] = true
	}
	var out []int
	top := 0
	for se, eps := range bySeason {
		if se > top {
			top = se
		}
		if len(missingEpisodes(eps)) > 0 {
			out = append(out, se)
		}
	}
	if len(out) == 0 && top > 0 {
		out = []int{top}
	}
	sort.Ints(out)
	return out
}

// localSpan returns the lowest and highest local episode number of one season,
// or (0, 0) when the season holds nothing.
func localSpan(nums map[int]bool, season int) (lo, hi int) {
	lo = 1 << 31
	for k := range nums {
		se, e := splitEpKey(k)
		if se != season {
			continue
		}
		if e < lo {
			lo = e
		}
		if e > hi {
			hi = e
		}
	}
	if hi == 0 {
		return 0, 0
	}
	return lo, hi
}

// seasonAlias maps a provider season onto the local season it is filed under.
// Identity is right whenever the library is filed the way the provider indexes
// it, which both the rename engine and Plex aim for. It is wrong for an AniList
// cour filed as "Season 1" that TVDB counts as season 2 - folderUnit reads that
// number from the Fribb mapping. The alias only fires when identity would match
// nothing at all, so it can never make a working list worse.
func seasonAlias(local []int, eps []provEpisode, unitSeason int) map[int]int {
	has := map[int]bool{}
	for _, e := range eps {
		has[e.Season] = true
	}
	m := make(map[int]int, len(local))
	for _, s := range local {
		m[s] = s
	}
	if len(local) == 1 && unitSeason > 0 && unitSeason != local[0] && !has[local[0]] && has[unitSeason] {
		return map[int]int{unitSeason: local[0]}
	}
	return m
}

// markBySeason flags each provider episode of the wanted seasons with whether
// the folder holds it. locals are the season-encoded numbers localEpisodeNums
// parsed out of the RENAMED file names, which for a plain watch already carry
// the provider's own season and episode - so the join is a direct lookup. The
// season written into each row is the LOCAL one: that is what is on disk.
func markBySeason(eps []provEpisode, locals map[int]bool, alias map[int]int) []WatchEpisode {
	out := []WatchEpisode{}
	for _, e := range eps {
		se, ok := alias[e.Season]
		if !ok {
			continue // a season the badge did not complain about
		}
		out = append(out, WatchEpisode{
			Season: se, Episode: e.Number, Absolute: e.Absolute,
			Title: e.Title, Aired: e.Aired,
			Have: locals[epKey(se, e.Number)],
		})
	}
	sortEpisodes(out)
	return out
}

// markByAbsolute flags provider episodes for a watch whose {episode-N} template
// renumbered them: the local file for absolute A is named A+offset, filed under
// the one season that part lives in. Only the span between the lowest and
// highest local number is listed - an absolute run has no upper bound, and the
// badge reports gaps inside exactly that span.
func markByAbsolute(eps []provEpisode, locals map[int]bool, season, offset int) []WatchEpisode {
	lo, hi := localSpan(locals, season)
	out := []WatchEpisode{}
	if hi == 0 {
		return out
	}
	for _, e := range eps {
		if e.Absolute == 0 {
			continue // specials and unnumbered entries have no place in this span
		}
		local := e.Absolute + offset
		if local < lo || local > hi {
			continue
		}
		out = append(out, WatchEpisode{
			Season: season, Episode: local, Absolute: e.Absolute, Local: local,
			Title: e.Title, Aired: e.Aired,
			Have: locals[epKey(season, local)],
		})
	}
	sortEpisodes(out)
	return out
}

// spanEpisodes is the provider-free list: every number between the lowest and
// highest local episode of each wanted season, which is the span
// missingEpisodes reports gaps in. Without a provider the modal still explains
// the badge, just without titles and dates.
func spanEpisodes(nums map[int]bool, seasons []int) []WatchEpisode {
	out := []WatchEpisode{}
	for _, se := range seasons {
		lo, hi := localSpan(nums, se)
		for e := lo; e <= hi && hi > 0; e++ {
			out = append(out, WatchEpisode{Season: se, Episode: e, Have: nums[epKey(se, e)]})
		}
	}
	sortEpisodes(out)
	return out
}

func sortEpisodes(eps []WatchEpisode) {
	sort.Slice(eps, func(i, j int) bool {
		if eps[i].Season != eps[j].Season {
			return eps[i].Season < eps[j].Season
		}
		return eps[i].Episode < eps[j].Episode
	})
}

// providerEpisodes fetches the episode list from the resolved provider. TVDB
// answers the whole series in one (cached) call; seasons only matters for TMDB,
// which is queried per season.
func (s *Server) providerEpisodes(ctx context.Context, p watchProvider, seasons []int, lang string) ([]provEpisode, error) {
	switch p.Name {
	case "tvdb":
		eps, err := s.Tvdb.EpisodesLang(ctx, p.SeriesID, p.Ordering, lang)
		if err != nil {
			return nil, err
		}
		out := make([]provEpisode, 0, len(eps))
		for _, e := range eps {
			out = append(out, provEpisode{
				Season: e.SeasonNumber, Number: e.Number, Absolute: e.AbsoluteNumber,
				Title: e.Name, Aired: e.Aired,
			})
		}
		return out, nil
	case "tmdb":
		var out []provEpisode
		for _, se := range seasons {
			eps, err := s.Tmdb.Season(ctx, p.SeriesID, se)
			if err != nil {
				return nil, err
			}
			for _, e := range eps {
				out = append(out, provEpisode{
					Season: e.Season, Number: e.Number, Title: e.Name, Aired: e.AirDate,
				})
			}
		}
		return out, nil
	}
	return nil, nil
}

// handleWatchEpisodes lists the watched series' episodes from the metadata
// provider and marks which ones the local folder holds. It is the detail view
// behind the gap badge and is fetched only when that modal opens: the watches
// list polls every 10s and must never touch a provider.
//
//	@Summary		Watch episode list
//	@Description	Provider episode list for one watch's series, each episode flagged as present or missing locally. Falls back to the numbers parsed from the local file names when no provider series resolves.
//	@Tags			Watches
//	@Produce		json
//	@Param			id	path		int	true	"Watch ID"
//	@Success		200	{object}	WatchEpisodesResponse
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/watches/{id}/episodes [get]
func (s *Server) handleWatchEpisodes(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var wt Watch
	if s.DB.QueryRow(`SELECT id, user_id, server_id, remote_path, local_path, subfolder, template,
			from_episode, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id
		FROM watches WHERE id = ? AND user_id = ?`, pathID(r), u.ID).
		Scan(&wt.ID, &wt.UserID, &wt.ServerID, &wt.RemotePath, &wt.LocalPath, &wt.Subfolder, &wt.Template,
			&wt.FromEpisode, &wt.AiredMapping, &wt.RenameProvider, &wt.RenameOrdering,
			&wt.RenameTitleLang, &wt.RenameSeriesID) != nil {
		writeErr(w, http.StatusNotFound, "watch not found")
		return
	}

	// exactly the local scope and minEp rule handleWatchesList counts gaps with,
	// so the modal explains the very badge that opened it
	local := wt.LocalPath
	if wt.Subfolder {
		local = path.Join(wt.LocalPath, path.Base(wt.RemotePath))
	}
	minEp := wt.FromEpisode
	if wt.AiredMapping {
		minEp = 0
	}
	nums := s.localEpisodeNums(local, minEp)
	seasons := gapSeasons(nums)
	offset := watchOffset(wt.Template)

	resp := WatchEpisodesResponse{Episodes: []WatchEpisode{}}
	p := s.watchProviderFor(wt)
	resp.Provider, resp.SeriesID = p.Name, p.SeriesID

	var eps []provEpisode
	var err error
	if p.Name != "" {
		lang := wt.RenameTitleLang
		if lang == "" {
			lang = s.userLocale(u.ID) // the modal is UI, so the UI language wins
		}
		eps, err = s.providerEpisodes(r.Context(), p, seasons, lang)
	}
	// the folder starts at from_episode, the provider does not: without this the
	// episodes below it would all read as missing, though they belong to another
	// watch on the same shared season folder. Filtered here so the join stays dumb.
	if minEp > 0 && offset == 0 {
		kept := eps[:0]
		for _, e := range eps {
			if e.Number >= minEp {
				kept = append(kept, e)
			}
		}
		eps = kept
	}

	switch {
	case p.Name == "":
		resp.Reason = "no_provider"
	case err != nil:
		resp.Reason = "provider_error"
	case len(eps) == 0:
		resp.Reason = "no_series"
	}
	switch {
	case resp.Reason != "":
		resp.Episodes = spanEpisodes(nums, seasons)
	case offset != 0 && len(seasons) == 1:
		// a renumbered part: the file names carry absolute+offset, not the
		// provider's season numbering
		resp.Episodes = markByAbsolute(eps, nums, seasons[0], offset)
	default:
		resp.Episodes = markBySeason(eps, nums, seasonAlias(seasons, eps, p.Season))
	}
	// an episode that has not aired yet cannot be missing - counting it would
	// make every currently running series look half broken
	today := time.Now().Format("2006-01-02")
	for i, e := range resp.Episodes {
		if e.Aired > today {
			resp.Episodes[i].Upcoming = true
			continue
		}
		if !e.Have {
			resp.Missing++
		}
	}
	if p.SeriesID != 0 {
		// cached provider media: carries the title and the stable provider URL
		// the footer links to, so no second place builds those
		if m := s.providerMedia(r.Context(), p.Name, p.SeriesID); m != nil {
			resp.Title, resp.URL = m.Title.Romaji, m.SiteURL
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
