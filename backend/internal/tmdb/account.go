package tmdb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// TMDB account linking via the v3 request-token flow: the configured API key
// is enough, no extra client registration. The session id then reads the
// account's watchlist.

// post mirrors get for the two authentication endpoints (JSON body, same
// v3-key/v4-bearer logic, no retry - these are interactive one-shots).
func (c *Client) post(ctx context.Context, path string, body, out any) error {
	if err := c.limiter.Wait(ctx); err != nil {
		return err
	}
	key := c.key()
	if key == "" {
		return fmt.Errorf("tmdb: no API key configured")
	}
	params := url.Values{}
	bearer := strings.Contains(key, ".")
	if !bearer {
		params.Set("api_key", key)
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path+"?"+params.Encode(), bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if bearer {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("tmdb: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// RequestToken starts the linking flow; the user approves the token at
// themoviedb.org/authenticate/{token}.
func (c *Client) RequestToken(ctx context.Context) (string, error) {
	var resp struct {
		Success      bool   `json:"success"`
		RequestToken string `json:"request_token"`
	}
	if err := c.get(ctx, "/authentication/token/new", nil, &resp); err != nil {
		return "", err
	}
	if !resp.Success || resp.RequestToken == "" {
		return "", fmt.Errorf("tmdb: request token denied")
	}
	return resp.RequestToken, nil
}

// CreateSession exchanges an approved request token for a session id.
func (c *Client) CreateSession(ctx context.Context, requestToken string) (string, error) {
	var resp struct {
		Success   bool   `json:"success"`
		SessionID string `json:"session_id"`
	}
	if err := c.post(ctx, "/authentication/session/new", map[string]string{"request_token": requestToken}, &resp); err != nil {
		return "", err
	}
	if !resp.Success || resp.SessionID == "" {
		return "", fmt.Errorf("tmdb: session denied")
	}
	return resp.SessionID, nil
}

// Account resolves the session's TMDB account id and display name.
func (c *Client) Account(ctx context.Context, sessionID string) (int, string, error) {
	var resp struct {
		ID       int    `json:"id"`
		Username string `json:"username"`
		Name     string `json:"name"`
	}
	if err := c.get(ctx, "/account", url.Values{"session_id": {sessionID}}, &resp); err != nil {
		return 0, "", err
	}
	if resp.ID == 0 {
		return 0, "", fmt.Errorf("tmdb: account lookup failed")
	}
	name := resp.Username
	if name == "" {
		name = resp.Name
	}
	return resp.ID, name, nil
}

// Watchlist returns the account's watchlist for kind "tv" or "movie",
// paginated (capped at 5 pages = 100 titles). Not cached here - the
// suggestions handler caches the filtered result.
func (c *Client) Watchlist(ctx context.Context, sessionID string, accountID int, kind string) ([]anilist.Media, error) {
	segment := kind
	if kind == "movie" {
		segment = "movies"
	}
	var out []anilist.Media
	for page := 1; page <= 5; page++ {
		var resp struct {
			Page       int         `json:"page"`
			TotalPages int         `json:"total_pages"`
			Results    []rawResult `json:"results"`
		}
		params := url.Values{
			"session_id": {sessionID},
			"language":   {"de-DE"},
			"page":       {strconv.Itoa(page)},
		}
		if err := c.get(ctx, fmt.Sprintf("/account/%d/watchlist/%s", accountID, segment), params, &resp); err != nil {
			return out, err
		}
		for _, r := range resp.Results {
			out = append(out, c.toMedia(kind, r))
		}
		if page >= resp.TotalPages {
			break
		}
	}
	return out, nil
}
