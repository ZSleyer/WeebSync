// Package anilist queries the public AniList GraphQL API with an SQLite
// response cache (TTL 24h) and a polite rate limit.
package anilist

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"golang.org/x/time/rate"
)

const endpoint = "https://graphql.anilist.co"
const cacheTTL = 24 * time.Hour

type Media struct {
	ID    int `json:"id"`
	Title struct {
		Romaji  string `json:"romaji"`
		English string `json:"english"`
	} `json:"title"`
	CoverImage struct {
		Large string `json:"large"`
	} `json:"coverImage"`
	BannerImage  string   `json:"bannerImage"`
	Episodes     int      `json:"episodes"`
	SeasonYear   int      `json:"seasonYear"`
	Format       string   `json:"format"`
	AverageScore int      `json:"averageScore"`
	Genres       []string `json:"genres"`
	Description  string   `json:"description"`
}

const mediaFields = `id title { romaji english } coverImage { large } bannerImage
	episodes seasonYear format averageScore genres description(asHtml: false)`

type Client struct {
	DB      *sql.DB
	HTTP    *http.Client
	token   string // optional AniList API token (ANILIST_TOKEN): higher rate limit
	limiter *rate.Limiter
}

func New(db *sql.DB) *Client {
	token := os.Getenv("ANILIST_TOKEN")
	// AniList allows ~90 req/min per IP; authenticated requests get their
	// own (higher) per-user budget, so pace less conservatively then.
	every := time.Second
	if token != "" {
		every = 500 * time.Millisecond
	}
	return &Client{
		DB:      db,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
		token:   token,
		limiter: rate.NewLimiter(rate.Every(every), 1),
	}
}

// cached returns the raw JSON payload for key if fresh enough.
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

func (c *Client) query(ctx context.Context, query string, variables map[string]any, out any) error {
	body, _ := json.Marshal(map[string]any{"query": query, "variables": variables})
	for attempt := 0; ; attempt++ {
		if err := c.limiter.Wait(ctx); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		if c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		// hard limit hit: honor Retry-After once, then give up
		if resp.StatusCode == http.StatusTooManyRequests && attempt == 0 {
			resp.Body.Close()
			wait := 60 * time.Second
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
		// nearly out of budget: slow the next request down
		if rem, perr := strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining")); perr == nil && rem < 5 {
			c.limiter.ReserveN(time.Now(), c.limiter.Burst())
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("anilist: HTTP %d", resp.StatusCode)
		}
		err = json.NewDecoder(resp.Body).Decode(out)
		resp.Body.Close()
		return err
	}
}

func (c *Client) Search(ctx context.Context, q string) ([]Media, error) {
	key := "search:" + q
	if payload, ok := c.cached(key); ok {
		var list []Media
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	var resp struct {
		Data struct {
			Page struct {
				Media []Media `json:"media"`
			} `json:"Page"`
		} `json:"data"`
	}
	gql := fmt.Sprintf(`query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME) { %s } } }`, mediaFields)
	if err := c.query(ctx, gql, map[string]any{"search": q}, &resp); err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(resp.Data.Page.Media)
	c.store(key, string(payload))
	return resp.Data.Page.Media, nil
}

func (c *Client) Media(ctx context.Context, id int) (*Media, error) {
	key := fmt.Sprintf("media:%d", id)
	if payload, ok := c.cached(key); ok {
		var m Media
		if json.Unmarshal([]byte(payload), &m) == nil {
			return &m, nil
		}
	}
	var resp struct {
		Data struct {
			Media *Media `json:"Media"`
		} `json:"data"`
	}
	gql := fmt.Sprintf(`query ($id: Int) { Media(id: $id, type: ANIME) { %s } }`, mediaFields)
	if err := c.query(ctx, gql, map[string]any{"id": id}, &resp); err != nil {
		return nil, err
	}
	if resp.Data.Media == nil {
		return nil, fmt.Errorf("anilist: media %d not found", id)
	}
	payload, _ := json.Marshal(resp.Data.Media)
	c.store(key, string(payload))
	return resp.Data.Media, nil
}
