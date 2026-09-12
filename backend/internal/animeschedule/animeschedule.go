// Package animeschedule is a thin client for AnimeSchedule.net's v3 API, the
// one timetable that dates English dub episodes ahead of their release,
// delays included. Needs an account token (free), read per request from the
// settings so the settings page can change it at runtime.
package animeschedule

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
)

type Client struct {
	DB      *sql.DB
	BaseURL string // overridable for tests
	HTTP    *http.Client
	lim     *rate.Limiter
}

func New(d *sql.DB) *Client {
	base := "https://animeschedule.net/api/v3"
	if v := os.Getenv("ANIMESCHEDULE_BASE_URL"); v != "" {
		base = v
	}
	return &Client{DB: d, BaseURL: base, HTTP: netguard.Client(15 * time.Second), lim: rate.NewLimiter(rate.Every(time.Second), 1)}
}

func (c *Client) token() string {
	return secret.SettingOrEnv(c.DB, "animeschedule_token", "ANIMESCHEDULE_TOKEN")
}

// Enabled reports whether a token is configured.
func (c *Client) Enabled() bool { return c != nil && c.token() != "" }

// Ping checks the token with the cheapest authenticated call there is.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Route(ctx, 189046) // Re:Zero season 4, a title the site has
	return err
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	tok := c.token()
	if tok == "" {
		return fmt.Errorf("animeschedule: no token configured")
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
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("animeschedule: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

// Route is the site's own id of an AniList title, "" when it lists none.
func (c *Client) Route(ctx context.Context, anilistID int) (string, error) {
	var out struct {
		Anime []struct {
			Route string `json:"route"`
		} `json:"anime"`
	}
	if err := c.get(ctx, "/anime?anilist-ids="+strconv.Itoa(anilistID), &out); err != nil {
		return "", err
	}
	if len(out.Anime) == 0 {
		return "", nil
	}
	return out.Anime[0].Route, nil
}

// Entry is one episode in a week's timetable. The field names are the API's
// (lower camel case); Go's decoder matches them case-insensitively, which
// also covers the capitalised spelling older clients document.
type Entry struct {
	Title         string `json:"title"`
	Route         string `json:"route"`
	EpisodeDate   string `json:"episodeDate"` // RFC 3339, in the tz asked for
	EpisodeNumber int    `json:"episodeNumber"`
	AirType       string `json:"airType"`
	DelayedUntil  string `json:"delayedUntil"`
}

// At is the entry's release moment in unix seconds, 0 when unparsable.
func (e Entry) At() int64 {
	t, err := time.Parse(time.RFC3339, e.EpisodeDate)
	if err != nil {
		return 0
	}
	return t.Unix()
}

// DubTimetable lists the English dub episodes of one ISO week.
func (c *Client) DubTimetable(ctx context.Context, year, week int) ([]Entry, error) {
	var out []Entry
	err := c.get(ctx, fmt.Sprintf("/timetables/dub?year=%d&week=%d&tz=UTC", year, week), &out)
	return out, err
}
