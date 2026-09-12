// Package crunchyroll reads release dates off Crunchyroll's content API - the
// one their own web player talks to; there is no public one. Anonymous: the
// web client's id gets a token good for browsing metadata, no account needed.
// Undocumented and known to change under tools like yt-dlp, so every caller
// treats a failure as "nothing learned" and never as a reason to stop.
//
// What it is for: an episode on Crunchyroll has one entry per audio language
// (its "versions"), and each version carries the moment it went live. That is
// the only structured record of when a dub was released. Versions exist only
// once released - nothing here predicts anything.
package crunchyroll

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/netguard"
)

type Client struct {
	BaseURL string // overridable for tests
	HTTP    *http.Client

	lim   *rate.Limiter
	mu    sync.Mutex
	token string
	exp   time.Time
}

// New returns a client for crunchyroll.com, or for CRUNCHYROLL_BASE_URL.
func New() *Client {
	base := "https://www.crunchyroll.com"
	if v := os.Getenv("CRUNCHYROLL_BASE_URL"); v != "" {
		base = v
	}
	return NewAt(base)
}

// NewAt returns a client for one base URL; a second a second, which is far
// below what the web player itself does while browsing.
func NewAt(base string) *Client {
	return &Client{BaseURL: strings.TrimRight(base, "/"), HTTP: netguard.Client(15 * time.Second), lim: rate.NewLimiter(rate.Every(time.Second), 1)}
}

// The web player identifies as a browser and as the client "cr_web", which
// has no secret: the header is base64("cr_web:").
const (
	userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
	webClient = "Basic Y3Jfd2ViOg=="
)

// authToken returns the anonymous bearer token, fetching a new one when the
// cached one is missing, about to expire, or force says so.
func (c *Client) authToken(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && c.token != "" && time.Now().Before(c.exp.Add(-time.Minute)) {
		return c.token, nil
	}
	if err := c.lim.Wait(ctx); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/auth/v1/token", strings.NewReader("grant_type=client_id"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", webClient)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("crunchyroll: token HTTP %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("crunchyroll: empty token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 300
	}
	c.token, c.exp = out.AccessToken, time.Now().Add(time.Duration(out.ExpiresIn)*time.Second)
	return c.token, nil
}

// get fetches path (already query-encoded) and decodes the payload. A 401
// refreshes the token once and retries.
func (c *Client) get(ctx context.Context, path string, out any) error {
	for attempt := 0; attempt < 2; attempt++ {
		tok, err := c.authToken(ctx, attempt == 1)
		if err != nil {
			return err
		}
		if err := c.lim.Wait(ctx); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("User-Agent", userAgent)
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			resp.Body.Close()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("crunchyroll: HTTP %d", resp.StatusCode)
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
		resp.Body.Close()
		return err
	}
	return fmt.Errorf("crunchyroll: unauthorized")
}

// Version is one audio language of a season or an episode; GUID names the
// entry that language lives under (an episode's versions are episodes).
type Version struct {
	AudioLocale string `json:"audio_locale"`
	GUID        string `json:"guid"`
	Original    bool   `json:"original"`
}

type Season struct {
	ID          string    `json:"id"`
	Number      int       `json:"season_number"`
	Title       string    `json:"title"`
	AudioLocale string    `json:"audio_locale"`
	Versions    []Version `json:"versions"`
}

// Episode as both the season listing and the objects endpoint describe it;
// the dates are RFC 3339 strings, an unreleased one carries a placeholder in
// the year 9998, which At() treats as unknown.
type Episode struct {
	ID          string    `json:"id"`
	Number      int       `json:"episode_number"`
	AudioLocale string    `json:"audio_locale"`
	AirDate     string    `json:"episode_air_date"`       // the original broadcast, dated to a day
	PremiumAt   string    `json:"premium_available_date"` // when this version went live
	Versions    []Version `json:"versions"`
}

// At parses one of the episode's dates to unix seconds; 0 when it is missing
// or a placeholder.
func At(s string) int64 {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil || t.Year() > 9000 {
		return 0
	}
	return t.Unix()
}

var idRe = regexp.MustCompile(`^[A-Z0-9]{5,32}$`)

func checkID(id string) error {
	if !idRe.MatchString(id) {
		return fmt.Errorf("crunchyroll: bad id %q", id)
	}
	return nil
}

type listing[T any] struct {
	Data []T `json:"data"`
}

// Seasons lists a series' seasons: one per original season, its dubs as
// versions. The locale only picks the language of the titles.
func (c *Client) Seasons(ctx context.Context, seriesID string) ([]Season, error) {
	if err := checkID(seriesID); err != nil {
		return nil, err
	}
	var out listing[Season]
	err := c.get(ctx, "/content/v2/cms/series/"+seriesID+"/seasons?locale=en-US", &out)
	return out.Data, err
}

// Episodes lists a season's episodes in the original language, each with the
// versions released so far. Asking for a dub's season id gives the same list.
func (c *Client) Episodes(ctx context.Context, seasonID string) ([]Episode, error) {
	if err := checkID(seasonID); err != nil {
		return nil, err
	}
	var out listing[Episode]
	err := c.get(ctx, "/content/v2/cms/seasons/"+seasonID+"/episodes?locale=en-US", &out)
	return out.Data, err
}

// Objects fetches episodes by id - the way to reach a dub version, whose
// release date is on the version's own entry. Up to 25 ids per request.
func (c *Client) Objects(ctx context.Context, ids []string) ([]Episode, error) {
	var eps []Episode
	for len(ids) > 0 {
		n := min(25, len(ids))
		chunk, rest := ids[:n], ids[n:]
		for _, id := range chunk {
			if err := checkID(id); err != nil {
				return nil, err
			}
		}
		var out listing[struct {
			ID   string   `json:"id"`
			Meta *Episode `json:"episode_metadata"`
		}]
		if err := c.get(ctx, "/content/v2/cms/objects/"+strings.Join(chunk, ",")+"?locale=en-US", &out); err != nil {
			return nil, err
		}
		for _, o := range out.Data {
			if o.Meta == nil {
				continue
			}
			e := *o.Meta
			e.ID = o.ID
			eps = append(eps, e)
		}
		ids = rest
	}
	return eps, nil
}

// Locale is the audio_locale Crunchyroll uses for a dub's short tag; "" for
// a language it does not dub into.
func Locale(lang string) string {
	switch lang {
	case "de":
		return "de-DE"
	case "en":
		return "en-US"
	case "fr":
		return "fr-FR"
	case "it":
		return "it-IT"
	case "es":
		return "es-ES"
	case "pt":
		return "pt-BR"
	}
	return ""
}

var seriesRe = regexp.MustCompile(`crunchyroll\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?series/([A-Z0-9]{5,32})`)

// SeriesID pulls the series id out of a Crunchyroll URL, "" when the link
// names the show by slug only - as AniList's older links do.
func SeriesID(u string) string {
	if m := seriesRe.FindStringSubmatch(u); m != nil {
		return m[1]
	}
	return ""
}
