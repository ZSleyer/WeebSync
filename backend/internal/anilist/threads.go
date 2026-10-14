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
		ID: r.ID, Body: clip(r.Comment), Likes: r.LikeCount, CreatedAt: r.CreatedAt,
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

func threadKey(id, page int) string { return fmt.Sprintf("thread1:%d:%d", id, page) }

// Thread fetches a thread's opening post and one page (1-based) of its
// comments, anonymously, cached for threadTTL under thread1:<id>:<page>.
func (c *Client) Thread(ctx context.Context, id, page int) (*ThreadPage, error) {
	if page < 1 {
		page = 1
	}
	key := threadKey(id, page)
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
	gql := `query ($id: Int, $page: Int) {
		Thread(id: $id) { id title body(asHtml: false) replyCount viewCount createdAt siteUrl user { name avatar { medium } } }
		Page(page: $page, perPage: ` + fmt.Sprint(threadPerPage) + `) { pageInfo { hasNextPage } threadComments(threadId: $id) { id comment(asHtml: false) likeCount createdAt user { name avatar { medium } } childComments } }
	}`
	// the reader is anonymous on purpose: a public thread reads the same for
	// everyone, so one cached page serves every user
	if err := c.queryAs(ctx, "", gql, map[string]any{"id": id, "page": page}, &resp); err != nil {
		return nil, err
	}
	th := resp.Data.Thread
	if th == nil {
		return nil, fmt.Errorf("anilist: thread %d not found", id)
	}
	out := ThreadPage{
		Thread: ThreadPost{
			ID: th.ID, Title: th.Title, Body: clip(th.Body), Replies: th.ReplyCount, Views: th.ViewCount,
			CreatedAt: th.CreatedAt, URL: th.SiteURL, User: ThreadUser{Name: th.User.Name, Avatar: th.User.Avatar.Medium},
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
