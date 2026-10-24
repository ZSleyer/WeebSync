package anilist

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Thread reading: one forum thread's opening post and its comments, page by
// page, for the in-app reader. Bodies stay AniList markdown (asHtml: false);
// the frontend renders them as text, never as HTML.

const (
	// threadPerPage is the comment page size (top-level comments).
	threadPerPage = 25
	// threadMaxDepth caps how far below a top-level comment replies are
	// walked. The reader indents one level and flattens the rest, so deeper
	// trees only cost payload.
	threadMaxDepth = 3
	// threadMaxReplies caps the replies kept under one top-level comment.
	threadMaxReplies = 50
	// threadMaxBody caps an opening post or comment, in bytes.
	threadMaxBody = 16 << 10
	// threadTTL keeps a page short-lived: discussions move faster than media.
	threadTTL = 10 * time.Minute
)

// ThreadUser is a post's author.
type ThreadUser struct {
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
}

// ThreadPost is the opening post of a thread.
type ThreadPost struct {
	ID        int        `json:"id"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Replies   int        `json:"replies"`
	Views     int        `json:"views"`
	CreatedAt int64      `json:"createdAt"`
	URL       string     `json:"url"`
	User      ThreadUser `json:"user"`
	Likes     int        `json:"likes"`
	// IsLiked: the reading user likes it; always false on an anonymous read
	IsLiked bool `json:"isLiked"`
}

// ThreadComment is one comment. Top-level comments carry their replies
// flattened in thread order; a reply to a reply names whom it answers in
// ReplyTo (empty for a direct reply to the top-level comment).
type ThreadComment struct {
	ID        int             `json:"id"`
	Body      string          `json:"body"`
	Likes     int             `json:"likes"`
	CreatedAt int64           `json:"createdAt"`
	User      ThreadUser      `json:"user"`
	IsLiked   bool            `json:"isLiked"`
	ReplyTo   string          `json:"replyTo,omitempty"`
	Replies   []ThreadComment `json:"replies"`
}

// ThreadPage is the opening post plus one page of comments.
type ThreadPage struct {
	Thread      ThreadPost      `json:"thread"`
	Comments    []ThreadComment `json:"comments"`
	HasNextPage bool            `json:"hasNextPage"`
}

// rawComment is AniList's comment shape; childComments is untyped JSON of
// the same shape, recursively.
type rawComment struct {
	ID        int    `json:"id"`
	Comment   string `json:"comment"`
	LikeCount int    `json:"likeCount"`
	IsLiked   bool   `json:"isLiked"`
	CreatedAt int64  `json:"createdAt"`
	User      struct {
		Name   string `json:"name"`
		Avatar struct {
			Medium string `json:"medium"`
		} `json:"avatar"`
	} `json:"user"`
	ChildComments json.RawMessage `json:"childComments"`
}

func (r rawComment) flat() ThreadComment {
	return ThreadComment{
		ID: r.ID, Body: clip(r.Comment), Likes: r.LikeCount, IsLiked: r.IsLiked, CreatedAt: r.CreatedAt,
		User: ThreadUser{Name: r.User.Name, Avatar: r.User.Avatar.Medium}, Replies: []ThreadComment{},
	}
}

// children decodes childComments; null, absent or malformed reads as none.
func (r rawComment) children() []rawComment {
	var kids []rawComment
	if len(r.ChildComments) == 0 || json.Unmarshal(r.ChildComments, &kids) != nil {
		return nil
	}
	return kids
}

// flatten walks the reply tree under a top-level comment depth-first, in
// thread order, up to threadMaxDepth levels and threadMaxReplies replies.
func flatten(parent rawComment, depth int, top bool, out *[]ThreadComment) {
	if depth > threadMaxDepth {
		return
	}
	for _, k := range parent.children() {
		if len(*out) >= threadMaxReplies {
			return
		}
		c := k.flat()
		if !top {
			c.ReplyTo = parent.User.Name
		}
		*out = append(*out, c)
		flatten(k, depth+1, false, out)
	}
}

// clip cuts s to threadMaxBody bytes on a rune boundary.
func clip(s string) string {
	if len(s) <= threadMaxBody {
		return s
	}
	s = s[:threadMaxBody]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return strings.TrimRight(s, " \n") + " …"
}

// threadKey names a cached page: thread1:<id>:<page>, with :u<viewer> for
// a read under a user's token (whose likes it carries).
func threadKey(id, page, viewer int) string {
	if viewer > 0 {
		return fmt.Sprintf("thread1:%d:%d:u%d", id, page, viewer)
	}
	return fmt.Sprintf("thread1:%d:%d", id, page)
}

// InvalidateThread drops every cached page of a thread, anonymous and per
// user, after a reply or a like changed it. A key range, not LIKE, so the
// primary key index answers it.
func (c *Client) InvalidateThread(id int) {
	// a failed drop leaves the pages to age out on their TTL
	_, _ = c.DB.Exec(`DELETE FROM anilist_cache WHERE key >= ? AND key < ?`,
		fmt.Sprintf("thread1:%d:", id), fmt.Sprintf("thread1:%d;", id))
}

// Thread fetches a thread's opening post and one page (1-based) of its
// comments anonymously; see ThreadAs.
func (c *Client) Thread(ctx context.Context, id, page int) (*ThreadPage, error) {
	return c.ThreadAs(ctx, "", 0, id, page)
}

// ThreadAs fetches a thread page with token as the reading user (viewer is
// their AniList id), so the likes say whether that user likes them; an empty
// token reads anonymously. Cached for threadTTL per thread, page and viewer.
func (c *Client) ThreadAs(ctx context.Context, token string, viewer, id, page int) (*ThreadPage, error) {
	if page < 1 {
		page = 1
	}
	if token == "" {
		viewer = 0
	}
	key := threadKey(id, page, viewer)
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).
		Scan(&payload, &fetched); err == nil {
		if t, err := time.Parse("2006-01-02 15:04:05", fetched); err == nil && time.Since(t) <= threadTTL {
			var p ThreadPage
			if json.Unmarshal([]byte(payload), &p) == nil {
				return &p, nil
			}
		}
	}
	var resp struct {
		Data struct {
			Thread *struct {
				ID         int    `json:"id"`
				Title      string `json:"title"`
				Body       string `json:"body"`
				ReplyCount int    `json:"replyCount"`
				ViewCount  int    `json:"viewCount"`
				CreatedAt  int64  `json:"createdAt"`
				SiteURL    string `json:"siteUrl"`
				LikeCount  int    `json:"likeCount"`
				IsLiked    bool   `json:"isLiked"`
				User       struct {
					Name   string `json:"name"`
					Avatar struct {
						Medium string `json:"medium"`
					} `json:"avatar"`
				} `json:"user"`
			} `json:"Thread"`
			Page struct {
				PageInfo struct {
					HasNextPage bool `json:"hasNextPage"`
				} `json:"pageInfo"`
				ThreadComments []rawComment `json:"threadComments"`
			} `json:"Page"`
		} `json:"data"`
	}
	// isLiked asked for at the top level also comes back inside the
	// childComments JSON, which mirrors the selection
	gql := `query ($id: Int, $page: Int) {
		Thread(id: $id) { id title body(asHtml: false) replyCount viewCount createdAt siteUrl likeCount isLiked user { name avatar { medium } } }
		Page(page: $page, perPage: ` + fmt.Sprint(threadPerPage) + `) { pageInfo { hasNextPage } threadComments(threadId: $id) { id comment(asHtml: false) likeCount isLiked createdAt user { name avatar { medium } } childComments } }
	}`
	missKey := fmt.Sprintf("thread-miss:%d", id)
	if c.knownMissing(missKey) {
		return nil, fmt.Errorf("%w: thread %d", ErrNotFound, id)
	}
	if err := c.queryAs(ctx, token, gql, map[string]any{"id": id, "page": page}, &resp); err != nil {
		if isNotFound(err) {
			c.remember404(missKey)
			return nil, fmt.Errorf("%w: thread %d", ErrNotFound, id)
		}
		return nil, err
	}
	th := resp.Data.Thread
	if th == nil {
		c.remember404(missKey)
		return nil, fmt.Errorf("%w: thread %d", ErrNotFound, id)
	}
	out := ThreadPage{
		Thread: ThreadPost{
			ID: th.ID, Title: th.Title, Body: clip(th.Body), Replies: th.ReplyCount, Views: th.ViewCount,
			CreatedAt: th.CreatedAt, URL: th.SiteURL, User: ThreadUser{Name: th.User.Name, Avatar: th.User.Avatar.Medium},
			Likes: th.LikeCount, IsLiked: th.IsLiked,
		},
		Comments:    []ThreadComment{},
		HasNextPage: resp.Data.Page.PageInfo.HasNextPage,
	}
	for _, r := range resp.Data.Page.ThreadComments {
		c := r.flat()
		flatten(r, 1, true, &c.Replies)
		out.Comments = append(out.Comments, c)
	}
	b, _ := json.Marshal(out)
	c.store(key, string(b))
	return &out, nil
}

// ThreadCommentMax caps a reply in characters. AniList documents no limit
// for forum comments; this keeps a reply to what a forum post is.
const ThreadCommentMax = 10000

// SaveThreadComment posts a reply to a thread as the token's user, under
// parent when it answers a comment (0 = the thread itself). Returns the new
// comment's id.
func (c *Client) SaveThreadComment(ctx context.Context, token string, threadID, parent int, text string) (int, error) {
	vars := map[string]any{"t": threadID, "c": text}
	gql := `mutation ($t: Int, $c: String) { SaveThreadComment(threadId: $t, comment: $c) { id } }`
	if parent > 0 {
		vars["parent"] = parent
		gql = `mutation ($t: Int, $c: String, $parent: Int) { SaveThreadComment(threadId: $t, comment: $c, parentCommentId: $parent) { id } }`
	}
	var resp struct {
		Data struct {
			SaveThreadComment *struct {
				ID int `json:"id"`
			} `json:"SaveThreadComment"`
		} `json:"data"`
	}
	if err := c.queryAs(ctx, token, gql, vars, &resp); err != nil {
		return 0, err
	}
	if resp.Data.SaveThreadComment == nil {
		return 0, fmt.Errorf("anilist: reply not saved")
	}
	return resp.Data.SaveThreadComment.ID, nil
}

// ToggleLike likes or unlikes a thread (THREAD) or a comment
// (THREAD_COMMENT) as the token's user and returns the new state.
func (c *Client) ToggleLike(ctx context.Context, token string, id int, typ string) (liked bool, likes int, err error) {
	var resp struct {
		Data struct {
			ToggleLikeV2 *struct {
				LikeCount int  `json:"likeCount"`
				IsLiked   bool `json:"isLiked"`
			} `json:"ToggleLikeV2"`
		} `json:"data"`
	}
	gql := `mutation ($id: Int, $type: LikeableType) { ToggleLikeV2(id: $id, type: $type) {
		... on Thread { likeCount isLiked } ... on ThreadComment { likeCount isLiked } } }`
	if err := c.queryAs(ctx, token, gql, map[string]any{"id": id, "type": typ}, &resp); err != nil {
		return false, 0, err
	}
	if resp.Data.ToggleLikeV2 == nil {
		return false, 0, fmt.Errorf("anilist: like not saved")
	}
	return resp.Data.ToggleLikeV2.IsLiked, resp.Data.ToggleLikeV2.LikeCount, nil
}
