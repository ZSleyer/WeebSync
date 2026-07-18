// Package tmdb queries The Movie Database (TMDB) for non-anime series and
// movies and maps results into the anilist.Media shape, so catalog, detail
// view and watch enrichment work unchanged. Results are cached in the same
// KV table as AniList responses.
package tmdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"golang.org/x/time/rate"
)

type Client struct {
	DB      *sql.DB
	BaseURL string // overridable for tests
	Images  string
	HTTP    *http.Client
	limiter *rate.Limiter
}

func New(d *sql.DB) *Client {
	base := "https://api.themoviedb.org/3"
	if v := os.Getenv("TMDB_BASE_URL"); v != "" {
		base = v // proxy/mirror override
	}
	return &Client{
		DB:      d,
		BaseURL: base,
		Images:  "https://image.tmdb.org/t/p",
		HTTP:    netguard.Client(15 * time.Second),
		limiter: rate.NewLimiter(rate.Every(250*time.Millisecond), 2),
	}
}

// key is read per request so the settings UI can change it at runtime.
// Accepts a v4 read access token (JWT, sent as Bearer header) or a v3 key
// (sent as api_key query parameter).
func (c *Client) key() string {
	return db.SettingOrEnv(c.DB, "tmdb_api_key", "TMDB_API_KEY")
}

// Enabled reports whether a TMDB key is configured.
func (c *Client) Enabled() bool { return c.key() != "" }

// cacheTTL is the response-cache lifetime: the ttl_tmdb_h setting in hours,
// default 24 (read per call so changes take effect immediately).
func (c *Client) cacheTTL() time.Duration {
	if h, _ := strconv.Atoi(db.Setting(c.DB, "ttl_tmdb_h")); h > 0 {
		return time.Duration(h) * time.Hour
	}
	return 24 * time.Hour
}

func (c *Client) get(ctx context.Context, path string, params url.Values, out any) error {
	if err := c.limiter.Wait(ctx); err != nil {
		return err
	}
	key := c.key()
	if key == "" {
		return fmt.Errorf("tmdb: no API key configured")
	}
	if params == nil {
		params = url.Values{}
	}
	bearer := strings.Contains(key, ".") // v4 JWT
	if !bearer {
		params.Set("api_key", key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path+"?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if bearer {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	for attempt := 0; ; attempt++ {
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		// rate limited: honor Retry-After once, then give up (same policy
		// as the AniList client)
		if resp.StatusCode == http.StatusTooManyRequests && attempt == 0 {
			resp.Body.Close()
			wait := 10 * time.Second
			if ra, perr := strconv.Atoi(resp.Header.Get("Retry-After")); perr == nil && ra > 0 {
				wait = time.Duration(ra) * time.Second
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
				continue
			}
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("tmdb: HTTP %d", resp.StatusCode)
		}
		err = json.NewDecoder(resp.Body).Decode(out)
		resp.Body.Close()
		return err
	}
}

// ── cache (shared KV table) ─────────────────────────────────

func (c *Client) cached(key string) (string, bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).
		Scan(&payload, &fetched); err != nil {
		return "", false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	if err != nil || time.Since(t) > c.cacheTTL() {
		return "", false
	}
	return payload, true
}

func (c *Client) store(key, payload string) {
	c.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`, key, payload)
}

// CachedMedia returns the cached media even when stale (instant display);
// fresh reports TTL validity so callers can refresh airing titles.
func (c *Client) CachedMedia(kind string, id int) (m *anilist.Media, fresh bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`,
		fmt.Sprintf("tmdb:media:%s:%d", kind, id)).Scan(&payload, &fetched); err != nil {
		return nil, false
	}
	var out anilist.Media
	if json.Unmarshal([]byte(payload), &out) != nil {
		return nil, false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	return &out, err == nil && time.Since(t) <= c.cacheTTL()
}

// ── mapping ─────────────────────────────────────────────────

type rawResult struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`  // tv
	Title        string `json:"title"` // movie
	OriginalName string `json:"original_name"`
	OrigTitle    string `json:"original_title"`
	FirstAirDate string `json:"first_air_date"`
	ReleaseDate  string `json:"release_date"`
	PosterPath   string `json:"poster_path"`
	BackdropPath string `json:"backdrop_path"`
	Overview     string `json:"overview"`
	GenreObjs    []struct {
		Name string `json:"name"`
	} `json:"genres"`
	Status      string  `json:"status"`
	NumEpisodes int     `json:"number_of_episodes"`
	VoteAverage float64 `json:"vote_average"`
	Seasons     []struct {
		SeasonNumber int `json:"season_number"`
		EpisodeCount int `json:"episode_count"`
	} `json:"seasons"`
	NextEpisode *struct {
		AirDate       string `json:"air_date"`
		SeasonNumber  int    `json:"season_number"`
		EpisodeNumber int    `json:"episode_number"`
	} `json:"next_episode_to_air"`
	Collection *struct {
		ID int `json:"id"`
	} `json:"belongs_to_collection"` // movie details only
	Videos struct {
		Results []struct {
			Key  string `json:"key"`
			Site string `json:"site"`
			Type string `json:"type"`
		} `json:"results"`
	} `json:"videos"`
}

// absoluteEpisode turns TMDB's per-season next_episode_to_air into an absolute
// episode number (episodes in all prior regular seasons + its episode_number),
// so the watch's Behind math (NextAiring.Episode - 1 vs local files) is exact.
// Falls back to NumEpisodes+1 when season data is missing.
func absoluteEpisode(r rawResult) int {
	if r.NextEpisode == nil {
		return r.NumEpisodes + 1
	}
	prior := 0
	for _, s := range r.Seasons {
		if s.SeasonNumber > 0 && s.SeasonNumber < r.NextEpisode.SeasonNumber {
			prior += s.EpisodeCount
		}
	}
	if abs := prior + r.NextEpisode.EpisodeNumber; abs > 0 {
		return abs
	}
	return r.NumEpisodes + 1
}

// statusMap translates TMDB status strings into the AniList vocabulary the
// frontend already knows.
func statusMap(s string) string {
	switch s {
	case "Returning Series":
		return "RELEASING"
	case "Ended", "Released":
		return "FINISHED"
	case "Canceled":
		return "CANCELLED"
	case "In Production", "Planned", "Post Production":
		return "NOT_YET_RELEASED"
	}
	return s
}

func (c *Client) toMedia(kind string, r rawResult) anilist.Media {
	var m anilist.Media
	m.ID = r.ID
	// Romaji is what the UI displays first → localized name; original as English
	m.Title.Romaji = firstOf(r.Name, r.Title)
	m.Title.English = firstOf(r.OriginalName, r.OrigTitle)
	if r.PosterPath != "" {
		m.CoverImage.Large = c.Images + "/w500" + r.PosterPath
	}
	if r.BackdropPath != "" {
		m.BannerImage = c.Images + "/w1280" + r.BackdropPath
	}
	if d := firstOf(r.FirstAirDate, r.ReleaseDate); len(d) >= 4 {
		m.SeasonYear, _ = strconv.Atoi(d[:4])
	}
	m.Format = map[string]string{"tv": "TV", "movie": "MOVIE"}[kind]
	m.Status = statusMap(r.Status)
	m.Episodes = r.NumEpisodes
	if kind == "movie" {
		m.Episodes = 1
		if m.Status == "" && r.ReleaseDate != "" {
			m.Status = "FINISHED"
		}
	}
	m.AverageScore = int(r.VoteAverage * 10)
	m.Description = r.Overview
	for _, g := range r.GenreObjs {
		m.Genres = append(m.Genres, g.Name)
	}
	if r.NextEpisode != nil && r.NextEpisode.AirDate != "" {
		if t, err := time.Parse("2006-01-02", r.NextEpisode.AirDate); err == nil {
			m.NextAiring = &struct {
				AiringAt int64 `json:"airingAt"`
				Episode  int   `json:"episode"`
			}{
				AiringAt: t.Unix(), // release day 00:00 UTC, TMDB has no airtime
				// absolute episode number: episodes in prior seasons + the
				// per-season episode_number. seasons[] ships in the /tv/{id}
				// details, so this is exact with no extra call.
				// ponytail: seasons[] suffices; no per-episode /season/{n} fetch
				// (TMDB has no per-episode airtimes anyway).
				Episode: absoluteEpisode(r),
			}
		}
	}
	for _, v := range r.Videos.Results {
		if v.Site == "YouTube" && v.Type == "Trailer" {
			m.Trailer = &struct {
				ID        string `json:"id"`
				Site      string `json:"site"`
				Thumbnail string `json:"thumbnail"`
			}{ID: v.Key, Site: "youtube"}
			break
		}
	}
	return m
}

func firstOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ── API ─────────────────────────────────────────────────────

// Search looks up series (kind "tv") or movies (kind "movie") by title,
// optionally narrowed by year. Cached like AniList searches.
func (c *Client) Search(ctx context.Context, kind, query string, year int) ([]anilist.Media, error) {
	// normalized key: folder-name variants of the same title share the entry
	norm := strings.ToLower(strings.Join(strings.Fields(query), " "))
	cacheKey := fmt.Sprintf("tmdb:search:%s:%s|%d", kind, norm, year)
	if payload, ok := c.cached(cacheKey); ok {
		var list []anilist.Media
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	params := url.Values{"query": {query}, "language": {"de-DE"}}
	if year > 0 {
		if kind == "tv" {
			params.Set("first_air_date_year", strconv.Itoa(year))
		} else {
			params.Set("year", strconv.Itoa(year))
		}
	}
	var resp struct {
		Results []rawResult `json:"results"`
	}
	if err := c.get(ctx, "/search/"+kind, params, &resp); err != nil {
		return nil, err
	}
	list := make([]anilist.Media, 0, len(resp.Results))
	for i, r := range resp.Results {
		if i == 10 {
			break
		}
		list = append(list, c.toMedia(kind, r))
	}
	payload, _ := json.Marshal(list)
	c.store(cacheKey, string(payload))
	// a year-narrowed hit also answers the plain search for the same title
	// ("Show (2020)" vs "Show" folders); empty results don't poison it
	if year > 0 && len(list) > 0 {
		c.store(fmt.Sprintf("tmdb:search:%s:%s|0", kind, norm), string(payload))
	}
	return list, nil
}

// Media fetches full details (episodes, status, trailer, next airing) and
// caches them under tmdb:media:<kind>:<id>.
func (c *Client) Media(ctx context.Context, kind string, id int) (*anilist.Media, error) {
	cacheKey := fmt.Sprintf("tmdb:media:%s:%d", kind, id)
	if payload, ok := c.cached(cacheKey); ok {
		var m anilist.Media
		if json.Unmarshal([]byte(payload), &m) == nil {
			return &m, nil
		}
	}
	var r rawResult
	params := url.Values{
		"language":               {"de-DE"},
		"append_to_response":     {"videos"},
		"include_video_language": {"de,en"},
	}
	if err := c.get(ctx, fmt.Sprintf("/%s/%d", kind, id), params, &r); err != nil {
		return nil, err
	}
	m := c.toMedia(kind, r)
	payload, _ := json.Marshal(m)
	c.store(cacheKey, string(payload))
	if kind == "movie" {
		collID := 0
		if r.Collection != nil {
			collID = r.Collection.ID
		}
		c.store(fmt.Sprintf("tmdb:coll-of:%d", id), strconv.Itoa(collID))
	}
	return &m, nil
}

// Reviews returns community reviews of a series or movie, mapped into the
// AniList review shape. No language filter - German reviews barely exist, the
// default returns mostly-English ones.
func (c *Client) Reviews(ctx context.Context, kind string, id int) ([]anilist.Review, error) {
	cacheKey := fmt.Sprintf("tmdb:reviews3:%s:%d", kind, id)
	if payload, ok := c.cached(cacheKey); ok {
		var list []anilist.Review
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	var resp struct {
		Results []struct {
			Author        string `json:"author"`
			Content       string `json:"content"`
			AuthorDetails struct {
				Rating     float64 `json:"rating"`
				AvatarPath string  `json:"avatar_path"`
			} `json:"author_details"`
		} `json:"results"`
	}
	if err := c.get(ctx, fmt.Sprintf("/%s/%d/reviews", kind, id), nil, &resp); err != nil {
		return nil, err
	}
	list := make([]anilist.Review, 0, len(resp.Results))
	for i, r := range resp.Results {
		if i == 15 {
			break
		}
		var rev anilist.Review
		rev.User.Name = r.Author
		if p := r.AuthorDetails.AvatarPath; p != "" {
			rev.User.Avatar.Medium = c.Images + "/w185" + p
		}
		rev.Score = int(r.AuthorDetails.Rating * 10)
		rev.Summary = truncate(r.Content, 600)
		list = append(list, rev)
	}
	payload, _ := json.Marshal(list)
	c.store(cacheKey, string(payload))
	return list, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// Trending lists this week's trending series (kind "tv") or movies.
func (c *Client) Trending(ctx context.Context, kind string) ([]anilist.Media, error) {
	cacheKey := "tmdb:trending:" + kind
	if payload, ok := c.cached(cacheKey); ok {
		var list []anilist.Media
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	var resp struct {
		Results []rawResult `json:"results"`
	}
	if err := c.get(ctx, "/trending/"+kind+"/week", url.Values{"language": {"de-DE"}}, &resp); err != nil {
		return nil, err
	}
	list := make([]anilist.Media, 0, len(resp.Results))
	for i, r := range resp.Results {
		if i == 20 {
			break
		}
		list = append(list, c.toMedia(kind, r))
	}
	payload, _ := json.Marshal(list)
	c.store(cacheKey, string(payload))
	return list, nil
}

// MovieCollection returns the id of the collection a movie belongs to
// (0 = standalone). Cached alongside the movie details.
func (c *Client) MovieCollection(ctx context.Context, movieID int) (int, error) {
	key := fmt.Sprintf("tmdb:coll-of:%d", movieID)
	if payload, ok := c.cached(key); ok {
		id, _ := strconv.Atoi(payload)
		return id, nil
	}
	var r rawResult
	if err := c.get(ctx, fmt.Sprintf("/movie/%d", movieID), url.Values{"language": {"de-DE"}}, &r); err != nil {
		return 0, err
	}
	id := 0
	if r.Collection != nil {
		id = r.Collection.ID
	}
	c.store(key, strconv.Itoa(id))
	return id, nil
}

// Collection lists the released movies of a TMDB collection, oldest first.
// Unreleased parts (empty or future release date) are skipped - they can't
// be downloaded yet.
func (c *Client) Collection(ctx context.Context, id int) ([]anilist.Media, error) {
	cacheKey := fmt.Sprintf("tmdb:collection:%d", id)
	if payload, ok := c.cached(cacheKey); ok {
		var list []anilist.Media
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	var resp struct {
		Parts []rawResult `json:"parts"`
	}
	if err := c.get(ctx, fmt.Sprintf("/collection/%d", id), url.Values{"language": {"de-DE"}}, &resp); err != nil {
		return nil, err
	}
	today := time.Now().UTC().Format("2006-01-02")
	list := make([]anilist.Media, 0, len(resp.Parts))
	for _, p := range resp.Parts {
		if p.ReleaseDate == "" || p.ReleaseDate > today {
			continue
		}
		list = append(list, c.toMedia("movie", p))
	}
	sort.Slice(list, func(i, j int) bool { return list[i].SeasonYear < list[j].SeasonYear })
	payload, _ := json.Marshal(list)
	c.store(cacheKey, string(payload))
	return list, nil
}
