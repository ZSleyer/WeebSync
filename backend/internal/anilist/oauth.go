package anilist

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// AniList OAuth2 (authorization code grant). Access tokens live ~1 year and
// there is no refresh token; callers store expires_at and re-connect.

var oauthTokenURL = "https://anilist.co/api/v2/oauth/token"

func init() {
	if v := os.Getenv("ANILIST_OAUTH_URL"); v != "" {
		oauthTokenURL = v // test override
	}
}

// ExchangeCode trades an authorization code for an access token.
func (c *Client) ExchangeCode(ctx context.Context, clientID, clientSecret, redirectURI, code string) (token string, expiresIn int, err error) {
	body, _ := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     clientID,
		"client_secret": clientSecret,
		"redirect_uri":  redirectURI,
		"code":          code,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, oauthTokenURL, bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("anilist oauth: HTTP %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", 0, err
	}
	if out.AccessToken == "" {
		return "", 0, fmt.Errorf("anilist oauth: empty token")
	}
	return out.AccessToken, out.ExpiresIn, nil
}

// Viewer returns the authenticated AniList user.
func (c *Client) Viewer(ctx context.Context, token string) (id int, name, avatar string, err error) {
	var resp struct {
		Data struct {
			Viewer *struct {
				ID     int    `json:"id"`
				Name   string `json:"name"`
				Avatar struct {
					Medium string `json:"medium"`
				} `json:"avatar"`
			} `json:"Viewer"`
		} `json:"data"`
	}
	gql := `query { Viewer { id name avatar { medium } } }`
	if err := c.queryAs(ctx, token, gql, nil, &resp); err != nil {
		return 0, "", "", err
	}
	if resp.Data.Viewer == nil {
		return 0, "", "", fmt.Errorf("anilist: no viewer (token invalid?)")
	}
	v := resp.Data.Viewer
	return v.ID, v.Name, v.Avatar.Medium, nil
}

// ListEntry is one entry of a user's anime list.
type ListEntry struct {
	Status   string `json:"status"` // CURRENT | PLANNING | COMPLETED | PAUSED | REPEATING
	Progress int    `json:"progress"`
	Media    Media  `json:"media"`
}

const listTTL = time.Hour

// UserList returns the user's anime list (all relevant statuses, one query),
// cached for an hour under alist:<anilistUserID>.
func (c *Client) UserList(ctx context.Context, token string, anilistUserID int) ([]ListEntry, error) {
	cacheKey := fmt.Sprintf("alist:%d", anilistUserID)
	var payload, fetched string
	c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, cacheKey).Scan(&payload, &fetched)
	if t, err := time.Parse("2006-01-02 15:04:05", fetched); err == nil && time.Since(t) <= listTTL {
		var list []ListEntry
		if json.Unmarshal([]byte(payload), &list) == nil {
			return list, nil
		}
	}
	gql := fmt.Sprintf(`query ($id: Int) {
		MediaListCollection(userId: $id, type: ANIME, status_in: [CURRENT, PLANNING, COMPLETED, PAUSED, REPEATING]) {
			lists { entries { status progress media { %s } } }
		}
	}`, mediaFields)
	var resp struct {
		Data struct {
			MediaListCollection struct {
				Lists []struct {
					Entries []ListEntry `json:"entries"`
				} `json:"lists"`
			} `json:"MediaListCollection"`
		} `json:"data"`
	}
	if err := c.queryAs(ctx, token, gql, map[string]any{"id": anilistUserID}, &resp); err != nil {
		return nil, err
	}
	var list []ListEntry
	for _, l := range resp.Data.MediaListCollection.Lists {
		list = append(list, l.Entries...)
	}
	out, _ := json.Marshal(list)
	c.store(cacheKey, string(out))
	return list, nil
}

// InvalidateUserList drops the cached list (after progress mutations).
func (c *Client) InvalidateUserList(anilistUserID int) {
	c.DB.Exec(`DELETE FROM anilist_cache WHERE key = ?`, fmt.Sprintf("alist:%d", anilistUserID))
}

// CachedUserList returns the cached list without fetching (may be stale).
func (c *Client) CachedUserList(anilistUserID int) []ListEntry {
	var payload string
	c.DB.QueryRow(`SELECT payload FROM anilist_cache WHERE key = ?`, fmt.Sprintf("alist:%d", anilistUserID)).Scan(&payload)
	var list []ListEntry
	json.Unmarshal([]byte(payload), &list)
	return list
}

// SaveProgress sets the watched-episode count of a media on the user's list.
func (c *Client) SaveProgress(ctx context.Context, token string, mediaID, progress int) error {
	gql := `mutation ($m: Int, $p: Int) { SaveMediaListEntry(mediaId: $m, progress: $p) { id } }`
	var resp struct {
		Data struct {
			SaveMediaListEntry *struct {
				ID int `json:"id"`
			} `json:"SaveMediaListEntry"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := c.queryAs(ctx, token, gql, map[string]any{"m": mediaID, "p": progress}, &resp); err != nil {
		return err
	}
	if len(resp.Errors) > 0 {
		return fmt.Errorf("anilist: %s", resp.Errors[0].Message)
	}
	if resp.Data.SaveMediaListEntry == nil {
		return fmt.Errorf("anilist: progress not saved")
	}
	return nil
}
