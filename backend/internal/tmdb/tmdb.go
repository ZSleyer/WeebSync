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
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"golang.org/x/time/rate"
)

const cacheTTL = 24 * time.Hour

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
		HTTP:    &http.Client{Timeout: 15 * time.Second},
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
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("tmdb: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ── cache (shared KV table) ─────────────────────────────────

func (c *Client) cached(key string) (string, bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).
		Scan(&payload, &fetched); err != nil {
		return "", false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	if err != nil || time.Since(t) > cacheTTL {
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
	return &out, err == nil && time.Since(t) <= cacheTTL
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
	NextEpisode *struct {
		AirDate       string `json:"air_date"`
		EpisodeNumber int    `json:"episode_number"`
	} `json:"next_episode_to_air"`
	Videos struct {
		Results []struct {
			Key  string `json:"key"`
			Site string `json:"site"`
			Type string `json:"type"`
		} `json:"results"`
	} `json:"videos"`
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
				// ponytail: episode_number is per-season; the watch logic
				// compares against total local files, so total+1 fits better
				Episode: r.NumEpisodes + 1,
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
	cacheKey := fmt.Sprintf("tmdb:search:%s:%s|%d", kind, query, year)
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
	return &m, nil
}
