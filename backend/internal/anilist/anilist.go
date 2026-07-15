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
	limiter *rate.Limiter
}

func New(db *sql.DB) *Client {
	return &Client{
		DB:   db,
		HTTP: &http.Client{Timeout: 15 * time.Second},
		// AniList allows ~90 req/min; stay well under it
		limiter: rate.NewLimiter(rate.Every(time.Second), 1),
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
	if err := c.limiter.Wait(ctx); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{"query": query, "variables": variables})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("anilist: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
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
