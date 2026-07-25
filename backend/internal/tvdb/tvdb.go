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

// Ping checks the configured key by logging in. force skips the token cache,
// so the settings page can re-test after the key changed.
func (c *Client) Ping(ctx context.Context, force bool) error {
	_, err := c.authToken(ctx, force)
	return err
}

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

// Episode carries the numbers needed for the aired-order mapping. The airs*
// fields place a special (seasonNumber 0) relative to the regular run, so a
// recap released between two episodes can be filed under season 0. ID and Name
// are only for showing an episode to a human - the mapping ignores them.
type Episode struct {
	ID                int    `json:"id"`   // stable episode id, for a per-episode link
	Name              string `json:"name"` // provider default language unless EpisodesLang asked for another
	AbsoluteNumber    int    `json:"absoluteNumber"`
	SeasonNumber      int    `json:"seasonNumber"`
	Number            int    `json:"number"`
	Aired             string `json:"aired"`
	AirsAfterSeason   int    `json:"airsAfterSeason"`
	AirsBeforeSeason  int    `json:"airsBeforeSeason"`
	AirsBeforeEpisode int    `json:"airsBeforeEpisode"`
}

// Episodes returns every episode of a series in the given season type
// ("official" = aired order) in TVDB's default language, from the cache when
// it is warm.
func (c *Client) Episodes(ctx context.Context, seriesID int, seasonType string) ([]Episode, error) {
	return c.episodes(ctx, seriesID, seasonType, "", false)
}

// EpisodesFresh skips the cache. The aired-order map must never be rebuilt from
// a day-old list: a rebuild happens precisely because a number was missing, and
// answering it from the same stale copy makes the rebuild pointless - which is
// how an episode that aired today ends up renamed into season 1.
func (c *Client) EpisodesFresh(ctx context.Context, seriesID int, seasonType string) ([]Episode, error) {
	return c.episodes(ctx, seriesID, seasonType, "", true)
}

// EpisodesLang is Episodes with translated episode names: bcp47 "" keeps the
// provider default, otherwise the localized route is tried first and falls back
// to the default when the series has no translation - the same cascade
// SeriesTitle uses, because half a list of empty names is worse than English.
//
// Cached for one TTL. An endless series is a dozen paginated requests and the
// episode list is fetched again every time its modal opens. c.DB is nil in the
// package tests, which then always talk to the fake server.
func (c *Client) EpisodesLang(ctx context.Context, seriesID int, seasonType, bcp47 string) ([]Episode, error) {
	return c.episodes(ctx, seriesID, seasonType, bcp47, false)
}

func (c *Client) episodes(ctx context.Context, seriesID int, seasonType, bcp47 string, fresh bool) ([]Episode, error) {
	lang := ""
	if bcp47 != "" {
		lang = tvdbLang(bcp47)
	}
	key := fmt.Sprintf("tvdb:eps:%d:%s:%s", seriesID, seasonType, lang)
	if c.DB != nil && !fresh {
		if payload, ok := c.cached(key); ok {
			var hit []Episode
			if json.Unmarshal([]byte(payload), &hit) == nil {
				return hit, nil
			}
		}
	}
	out, err := c.episodePages(ctx, seriesID, seasonType, lang)
	// a series without that translation answers 404; the default list still has
	// the numbers, which is what every other caller needs
	if lang != "" && (err != nil || !anyNamed(out)) {
		if def, derr := c.episodePages(ctx, seriesID, seasonType, ""); derr == nil {
			out, err = def, nil
		}
	}
	if err != nil {
		return nil, err
	}
	if c.DB != nil && len(out) > 0 {
		if b, merr := json.Marshal(out); merr == nil {
			c.store(key, string(b))
		}
	}
	return out, nil
}

// anyNamed reports whether the list carries episode names at all. A translation
// route can answer 200 with every name blank, which reads as "no translation".
func anyNamed(eps []Episode) bool {
	for _, e := range eps {
		if e.Name != "" {
			return true
		}
	}
	return false
}

// episodePages walks the paginated episode route. The cap is a runaway guard:
// no real series has 1000 pages of 500 episodes.
func (c *Client) episodePages(ctx context.Context, seriesID int, seasonType, lang3 string) ([]Episode, error) {
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
		if lang3 != "" {
			path = fmt.Sprintf("/series/%d/episodes/%s/%s?page=%d", seriesID, seasonType, lang3, page)
		}
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

// SeasonTokenMap maps an episode token to its (season, episode) in aired order.
// Regular episodes use their absolute number as the token ("1165"). Specials
// (season 0) are placed by their airs* fields onto the ".5" release convention:
// a recap that airs after absolute A gets the token "A.5" (a second one at the
// same slot "A.6", and so on), resolving to (0, its season-0 number). This lets
// a fractional file name land in the specials folder as S00Exx.
func SeasonTokenMap(eps []Episode) map[string][2]int {
	m := make(map[string][2]int, len(eps))
	absOf := make(map[[2]int]int) // (season, number) -> absolute number
	lastEp := make(map[int]int)   // season -> highest episode number
	for _, e := range eps {
		if e.SeasonNumber > 0 && e.AbsoluteNumber > 0 {
			m[strconv.Itoa(e.AbsoluteNumber)] = [2]int{e.SeasonNumber, e.Number}
			absOf[[2]int{e.SeasonNumber, e.Number}] = e.AbsoluteNumber
			if e.Number > lastEp[e.SeasonNumber] {
				lastEp[e.SeasonNumber] = e.Number
			}
		}
	}
	slot := make(map[int]int) // base absolute -> specials already placed there
	for _, e := range eps {
		if e.SeasonNumber != 0 {
			continue
		}
		var base int
		switch {
		case e.AirsBeforeSeason > 0 && e.AirsBeforeEpisode > 1:
			base = absOf[[2]int{e.AirsBeforeSeason, e.AirsBeforeEpisode - 1}]
		case e.AirsAfterSeason > 0:
			base = absOf[[2]int{e.AirsAfterSeason, lastEp[e.AirsAfterSeason]}]
		}
		if base == 0 {
			continue // can't place it relative to a regular episode
		}
		m[fmt.Sprintf("%d.%d", base, 5+slot[base])] = [2]int{0, e.Number}
		slot[base]++
	}
	return m
}

// ParseID turns TVDB's string id into an int; 0 on failure.
func ParseID(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
