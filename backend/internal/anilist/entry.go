package anilist

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// One list entry of the linked user, read and written with the user's own
// token: lists can be private.

// ListStatuses are the statuses a list entry can have.
var ListStatuses = []string{"CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"}

// ListDate is a partial calendar date as AniList gives it; zero parts are
// unknown.
type ListDate struct {
	Year  int `json:"year"`
	Month int `json:"month"`
	Day   int `json:"day"`
}

// ListEntryDetail is the user's entry for one media.
type ListEntryDetail struct {
	ID       int    `json:"id"`
	Status   string `json:"status" enums:"CURRENT,PLANNING,COMPLETED,DROPPED,PAUSED,REPEATING"`
	Progress int    `json:"progress"`
	// ScoreRaw is the score on the 100-point scale, whatever format the
	// user rates in; 0 is unrated
	ScoreRaw    int      `json:"scoreRaw"`
	Repeat      int      `json:"repeat"`
	StartedAt   ListDate `json:"startedAt"`
	CompletedAt ListDate `json:"completedAt"`
	// UpdatedAt is unix seconds
	UpdatedAt int64 `json:"updatedAt"`
}

// listEntryRaw is the GraphQL shape: score is asked for as POINT_100.
type listEntryRaw struct {
	ID          int      `json:"id"`
	Status      string   `json:"status"`
	Progress    int      `json:"progress"`
	Score       float64  `json:"score"`
	Repeat      int      `json:"repeat"`
	StartedAt   ListDate `json:"startedAt"`
	CompletedAt ListDate `json:"completedAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

func (r *listEntryRaw) detail() *ListEntryDetail {
	if r == nil {
		return nil
	}
	return &ListEntryDetail{ID: r.ID, Status: r.Status, Progress: r.Progress, ScoreRaw: int(r.Score + 0.5),
		Repeat: r.Repeat, StartedAt: r.StartedAt, CompletedAt: r.CompletedAt, UpdatedAt: r.UpdatedAt}
}

const entryFields = `id status progress score(format: POINT_100) repeat startedAt { year month day } completedAt { year month day } updatedAt`

// ListEntry returns the user's entry for a media, nil (and no error) when
// the media is not on the list.
func (c *Client) ListEntry(ctx context.Context, token string, anilistUserID, mediaID int) (*ListEntryDetail, error) {
	var resp struct {
		Data struct {
			MediaList *listEntryRaw `json:"MediaList"`
		} `json:"data"`
	}
	gql := `query ($u: Int, $m: Int) { MediaList(userId: $u, mediaId: $m) { ` + entryFields + ` } }`
	err := c.queryAs(ctx, token, gql, map[string]any{"u": anilistUserID, "m": mediaID}, &resp)
	// AniList answers a missing entry with a 404 error, not an empty result
	var ge *GraphQLError
	if errors.As(err, &ge) && ge.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return resp.Data.MediaList.detail(), nil
}

// ScoreFormat returns the format the user rates in (POINT_100,
// POINT_10_DECIMAL, POINT_10, POINT_5, POINT_3), cached for a day under
// alopts:<anilistUserID>.
func (c *Client) ScoreFormat(ctx context.Context, token string, anilistUserID int) (string, error) {
	key := fmt.Sprintf("alopts:%d", anilistUserID)
	var payload, fetched string
	if c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).Scan(&payload, &fetched) == nil {
		if t, err := time.Parse("2006-01-02 15:04:05", fetched); err == nil && time.Since(t) <= 24*time.Hour && payload != "" {
			return payload, nil
		}
	}
	var resp struct {
		Data struct {
			User struct {
				MediaListOptions struct {
					ScoreFormat string `json:"scoreFormat"`
				} `json:"mediaListOptions"`
			} `json:"User"`
		} `json:"data"`
	}
	gql := `query ($u: Int) { User(id: $u) { mediaListOptions { scoreFormat } } }`
	if err := c.queryAs(ctx, token, gql, map[string]any{"u": anilistUserID}, &resp); err != nil {
		return "", err
	}
	f := resp.Data.User.MediaListOptions.ScoreFormat
	if f == "" {
		f = "POINT_100"
	}
	c.store(key, f)
	return f, nil
}

// EntryPatch is a change to a list entry; nil fields stay as they are.
type EntryPatch struct {
	Status   *string
	Progress *int
	ScoreRaw *int
}

// SaveListEntry creates or changes the user's entry for a media, sending
// only the fields the patch sets, and returns the entry as AniList keeps it.
func (c *Client) SaveListEntry(ctx context.Context, token string, mediaID int, p EntryPatch) (*ListEntryDetail, error) {
	vars := map[string]any{"m": mediaID}
	params := []string{"$m: Int"}
	args := []string{"mediaId: $m"}
	if p.Status != nil {
		vars["s"] = *p.Status
		params = append(params, "$s: MediaListStatus")
		args = append(args, "status: $s")
	}
	if p.Progress != nil {
		vars["p"] = *p.Progress
		params = append(params, "$p: Int")
		args = append(args, "progress: $p")
	}
	if p.ScoreRaw != nil {
		vars["r"] = *p.ScoreRaw
		params = append(params, "$r: Int")
		args = append(args, "scoreRaw: $r")
	}
	gql := `mutation (` + strings.Join(params, ", ") + `) { SaveMediaListEntry(` + strings.Join(args, ", ") + `) { ` + entryFields + ` } }`
	var resp struct {
		Data struct {
			SaveMediaListEntry *listEntryRaw `json:"SaveMediaListEntry"`
		} `json:"data"`
	}
	if err := c.queryAs(ctx, token, gql, vars, &resp); err != nil {
		return nil, err
	}
	if resp.Data.SaveMediaListEntry == nil {
		return nil, fmt.Errorf("anilist: entry not saved")
	}
	return resp.Data.SaveMediaListEntry.detail(), nil
}

// DeleteListEntry removes a list entry by its entry id.
func (c *Client) DeleteListEntry(ctx context.Context, token string, entryID int) error {
	var resp struct {
		Data struct {
			DeleteMediaListEntry *struct {
				Deleted bool `json:"deleted"`
			} `json:"DeleteMediaListEntry"`
		} `json:"data"`
	}
	gql := `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`
	if err := c.queryAs(ctx, token, gql, map[string]any{"id": entryID}, &resp); err != nil {
		return err
	}
	if resp.Data.DeleteMediaListEntry == nil || !resp.Data.DeleteMediaListEntry.Deleted {
		return fmt.Errorf("anilist: entry not removed")
	}
	return nil
}
