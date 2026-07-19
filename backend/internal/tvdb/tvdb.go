// Package tvdb is a thin client for the TheTVDB v4 API, used to resolve a
// series' aired-order season boundaries: it maps an absolute episode number
// to its (season, episode) in the official broadcast order. That mapping can't
// be derived arithmetically for endless shows (e.g. Detective Conan, where
// season 33 ends at absolute 1186 and 1187 becomes S34E01), so we ask TVDB.
package tvdb

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
)

type Client struct {
	DB      *sql.DB
	BaseURL string // overridable for tests
	HTTP    *http.Client

	mu      sync.Mutex
	token   string
	tokenAt time.Time
}

func New(d *sql.DB) *Client {
	base := "https://api4.thetvdb.com/v4"
	if v := os.Getenv("TVDB_BASE_URL"); v != "" {
		base = v // proxy/mirror override, also used by tests
	}
	return &Client{DB: d, BaseURL: base, HTTP: netguard.Client(15 * time.Second)}
}

// key is read per request so the settings UI can change it at runtime.
func (c *Client) key() string {
	return db.SettingOrEnv(c.DB, "tvdb_api_key", "TVDB_API_KEY")
}

// Enabled reports whether a TVDB key is configured.
func (c *Client) Enabled() bool { return c.key() != "" }

// authToken returns a bearer token, logging in when the cached one is missing
// or older than 24h. TVDB tokens live ~1 month; we refresh well within that.
func (c *Client) authToken(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && c.token != "" && time.Since(c.tokenAt) < 24*time.Hour {
		return c.token, nil
	}
	key := c.key()
	if key == "" {
		return "", fmt.Errorf("tvdb: no API key configured")
	}
	body, _ := json.Marshal(map[string]string{"apikey": key})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tvdb: login HTTP %d", resp.StatusCode)
	}
	var out struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Data.Token == "" {
		return "", fmt.Errorf("tvdb: empty token")
	}
	c.token, c.tokenAt = out.Data.Token, time.Now()
	return c.token, nil
}

// get fetches path (already query-encoded) and decodes the payload. On a 401
// it refreshes the token once and retries, so an expired token self-heals.
func (c *Client) get(ctx context.Context, path string, out any) error {
	for attempt := 0; attempt < 2; attempt++ {
		tok, err := c.authToken(ctx, attempt == 1)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			resp.Body.Close()
			continue // token expired → force a fresh login and retry
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("tvdb: HTTP %d", resp.StatusCode)
		}
		err = json.NewDecoder(resp.Body).Decode(out)
		resp.Body.Close()
		return err
	}
	return fmt.Errorf("tvdb: unauthorized")
}

// SearchResult is one series hit; TVDB returns the id as a string.
type SearchResult struct {
	TVDBID string `json:"tvdb_id"`
	Name   string `json:"name"`
	Year   string `json:"year"`
}

// Search returns series matches for a name, best-match first. Used only when
// no TVDB id is available from Plex.
func (c *Client) Search(ctx context.Context, query string) ([]SearchResult, error) {
	var resp struct {
		Data []SearchResult `json:"data"`
	}
	q := url.Values{"query": {query}, "type": {"series"}}
	if err := c.get(ctx, "/search?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// Episode carries just the numbers needed for the aired-order mapping.
type Episode struct {
	AbsoluteNumber int    `json:"absoluteNumber"`
	SeasonNumber   int    `json:"seasonNumber"`
	Number         int    `json:"number"`
	Aired          string `json:"aired"`
}

// Episodes returns every episode of a series in the given season type
// ("official" = aired order), following pagination. The cap is a runaway
// guard: no real series has 1000 pages of 500 episodes.
func (c *Client) Episodes(ctx context.Context, seriesID int, seasonType string) ([]Episode, error) {
	var out []Episode
	for page := 0; page < 1000; page++ {
		var resp struct {
			Data struct {
				Episodes []Episode `json:"episodes"`
			} `json:"data"`
			Links struct {
				Next string `json:"next"`
			} `json:"links"`
		}
		path := fmt.Sprintf("/series/%d/episodes/%s?page=%d", seriesID, seasonType, page)
		if err := c.get(ctx, path, &resp); err != nil {
			return nil, err
		}
		out = append(out, resp.Data.Episodes...)
		if resp.Links.Next == "" || len(resp.Data.Episodes) == 0 {
			break
		}
	}
	return out, nil
}

// AbsoluteMap builds absolute-episode → (season, episode) from a series'
// official-order episodes. Episodes without an absolute number (specials,
// unnumbered) are skipped, so only reliable arithmetic-free mappings remain.
func AbsoluteMap(eps []Episode) map[int][2]int {
	m := make(map[int][2]int, len(eps))
	for _, e := range eps {
		if e.AbsoluteNumber > 0 {
			m[e.AbsoluteNumber] = [2]int{e.SeasonNumber, e.Number}
		}
	}
	return m
}

// ParseID turns TVDB's string id into an int; 0 on failure.
func ParseID(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
