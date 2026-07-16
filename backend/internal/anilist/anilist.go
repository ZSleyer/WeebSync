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
	"strconv"
	"strings"
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
	BannerImage string `json:"bannerImage"`
	Trailer     *struct {
		ID        string `json:"id"`
		Site      string `json:"site"` // "youtube" | "dailymotion"
		Thumbnail string `json:"thumbnail"`
	} `json:"trailer"`
	// NextAiring is the upcoming episode's release slot (RELEASING titles);
	// nil for finished titles or cache entries predating the field.
	NextAiring *struct {
		AiringAt int64 `json:"airingAt"` // unix seconds
		Episode  int   `json:"episode"`
	} `json:"nextAiringEpisode"`
	Episodes     int      `json:"episodes"`
	SeasonYear   int      `json:"seasonYear"`
	Format       string   `json:"format"`
	Status       string   `json:"status"` // FINISHED | RELEASING | NOT_YET_RELEASED | CANCELLED | HIATUS
	AverageScore int      `json:"averageScore"`
	Genres       []string `json:"genres"`
	Description  string   `json:"description"`
}

const mediaFields = `id title { romaji english } coverImage { large } bannerImage
	trailer { id site thumbnail }
	nextAiringEpisode { airingAt episode }
	episodes seasonYear format status averageScore genres description(asHtml: false)`

type Client struct {
	DB   *sql.DB
	HTTP *http.Client
	// TokenSource supplies the bearer token for API requests (a linked
	// account's token, or an operator-provided one). Nil/empty = anonymous.
	TokenSource func() string
	limiter     *rate.Limiter
}

func New(d *sql.DB) *Client {
	return &Client{
		DB:   d,
		HTTP: &http.Client{Timeout: 15 * time.Second},
		// AniList currently serves 30 req/min (X-RateLimit-Limit header);
		// one request every 2s stays exactly within that. Batched searches
		// put up to 10 lookups into a single request, so effective matching
		// throughput is ~300 folders/min.
		limiter: rate.NewLimiter(rate.Every(2*time.Second), 1),
	}
}

// token is resolved per request so linked accounts take effect immediately.
func (c *Client) token() string {
	if c.TokenSource != nil {
		return c.TokenSource()
	}
	return ""
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
	return c.queryAs(ctx, c.token(), query, variables, out)
}

// queryAs runs a GraphQL request with an explicit bearer token (linked
// account calls: lists, mutations). Empty token = anonymous.
func (c *Client) queryAs(ctx context.Context, token, query string, variables map[string]any, out any) error {
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
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
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

// SearchReq is one lookup in a batched search. Season (WINTER/SPRING/SUMMER/
// FALL) and Year narrow the query when the folder structure provides them.
// Force bypasses the response cache (user-triggered re-match).
type SearchReq struct {
	Query  string
	Season string
	Year   int
	Force  bool
}

func (r SearchReq) cacheKey() string {
	if r.Season == "" && r.Year == 0 {
		return "search:" + r.Query
	}
	return fmt.Sprintf("search:%s|%s%d", r.Query, r.Season, r.Year)
}

// SearchBatch resolves several searches with one GraphQL request using field
// aliases, so a whole batch costs a single slot of the rate limit. Results
// are cached per request like Search.
func (c *Client) SearchBatch(ctx context.Context, reqs []SearchReq) ([][]Media, error) {
	out := make([][]Media, len(reqs))
	var missing []int
	for i, r := range reqs {
		if payload, ok := c.cached(r.cacheKey()); ok && !r.Force {
			var list []Media
			if json.Unmarshal([]byte(payload), &list) == nil {
				out[i] = list
				continue
			}
		}
		missing = append(missing, i)
	}
	if len(missing) == 0 {
		return out, nil
	}

	var decls, parts []string
	variables := map[string]any{}
	for n, i := range missing {
		r := reqs[i]
		decls = append(decls, fmt.Sprintf("$q%d: String", n))
		args := fmt.Sprintf("search: $q%d, type: ANIME", n)
		if r.Season != "" {
			decls = append(decls, fmt.Sprintf("$se%d: MediaSeason", n))
			args += fmt.Sprintf(", season: $se%d", n)
			variables[fmt.Sprintf("se%d", n)] = r.Season
		}
		if r.Year != 0 {
			decls = append(decls, fmt.Sprintf("$y%d: Int", n))
			args += fmt.Sprintf(", seasonYear: $y%d", n)
			variables[fmt.Sprintf("y%d", n)] = r.Year
		}
		parts = append(parts, fmt.Sprintf("r%d: Page(perPage: 10) { media(%s) { %s } }", n, args, mediaFields))
		variables[fmt.Sprintf("q%d", n)] = r.Query
	}
	gql := fmt.Sprintf("query (%s) { %s }", strings.Join(decls, ", "), strings.Join(parts, " "))
	var resp struct {
		Data map[string]struct {
			Media []Media `json:"media"`
		} `json:"data"`
	}
	if err := c.query(ctx, gql, variables, &resp); err != nil {
		return nil, err
	}
	for n, i := range missing {
		list := resp.Data[fmt.Sprintf("r%d", n)].Media
		out[i] = list
		payload, _ := json.Marshal(list)
		c.store(reqs[i].cacheKey(), string(payload))
	}
	return out, nil
}

// CachedMedia returns the cached media even when stale: the catalog favors
// instant display over freshness. fresh reports whether the entry is within
// the TTL, so the caller can decide to refresh airing titles in the
// background (finished ones never change). nil means nothing cached.
func (c *Client) CachedMedia(id int) (m *Media, fresh bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`,
		fmt.Sprintf("media:%d", id)).Scan(&payload, &fetched); err != nil {
		return nil, false
	}
	var out Media
	if json.Unmarshal([]byte(payload), &out) != nil {
		return nil, false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	return &out, err == nil && time.Since(t) <= cacheTTL
}

// CacheMedia stores m in the response cache, used when a search already
// returned the full object so no second Media request is needed.
func (c *Client) CacheMedia(m *Media) {
	payload, _ := json.Marshal(m)
	c.store(fmt.Sprintf("media:%d", m.ID), string(payload))
}

// Relation is one edge of a media's relation graph (SEQUEL, PREQUEL, ...).
type Relation struct {
	RelationType string `json:"relationType"`
	Node         Media  `json:"node"`
}

// RelationsBatch resolves the relation edges of several media with one
// aliased GraphQL request, cached per id ("rel2:<id>" — key bumped when the
// node field set grew by cover/year/score).
func (c *Client) RelationsBatch(ctx context.Context, ids []int) (map[int][]Relation, error) {
	out := make(map[int][]Relation, len(ids))
	var missing []int
	for _, id := range ids {
		if payload, ok := c.cached(fmt.Sprintf("rel2:%d", id)); ok {
			var rels []Relation
			if json.Unmarshal([]byte(payload), &rels) == nil {
				out[id] = rels
				continue
			}
		}
		missing = append(missing, id)
	}
	// aliased batches of 10, same budget thinking as SearchBatch
	for start := 0; start < len(missing); start += 10 {
		chunk := missing[start:min(start+10, len(missing))]
		var decls, parts []string
		variables := map[string]any{}
		for n, id := range chunk {
			decls = append(decls, fmt.Sprintf("$id%d: Int", n))
			parts = append(parts, fmt.Sprintf(
				`r%d: Media(id: $id%d, type: ANIME) { relations { edges { relationType(version: 2) node { id title { romaji english } format status episodes coverImage { large } seasonYear averageScore } } } }`, n, n))
			variables[fmt.Sprintf("id%d", n)] = id
		}
		gql := fmt.Sprintf("query (%s) { %s }", strings.Join(decls, ", "), strings.Join(parts, " "))
		var resp struct {
			Data map[string]struct {
				Relations struct {
					Edges []Relation `json:"edges"`
				} `json:"relations"`
			} `json:"data"`
		}
		if err := c.query(ctx, gql, variables, &resp); err != nil {
			return out, err
		}
		for n, id := range chunk {
			rels := resp.Data[fmt.Sprintf("r%d", n)].Relations.Edges
			out[id] = rels
			payload, _ := json.Marshal(rels)
			c.store(fmt.Sprintf("rel2:%d", id), string(payload))
		}
	}
	return out, nil
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
