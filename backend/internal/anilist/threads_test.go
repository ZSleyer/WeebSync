package anilist

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/time/rate"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// fakeGraphQL points the client at a local stand-in answering every request
// with body; it counts requests and records the last request's variables.
func fakeGraphQL(t *testing.T, body string) (*Client, *atomic.Int32, *atomic.Pointer[map[string]any]) {
	t.Helper()
	var n atomic.Int32
	var vars atomic.Pointer[map[string]any]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Variables map[string]any `json:"variables"`
		}
		json.Unmarshal(raw, &req)
		vars.Store(&req.Variables)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	old := endpoint
	endpoint = srv.URL
	t.Cleanup(func() { endpoint = old })
	c := New(dbtest.Open(t))
	c.HTTP = srv.Client()
	c.limiter = rate.NewLimiter(rate.Inf, 1)
	return c, &n, &vars
}

func TestThreadFlattensRepliesAndCaches(t *testing.T) {
	// a -> b -> c -> d -> e: four levels under the top-level comment a
	reply := func(id int, name, kids string) string {
		return `{"id":` + itoa(id) + `,"comment":"c` + itoa(id) + `","likeCount":1,"createdAt":5,"user":{"name":"` + name + `","avatar":{"medium":"m"}},"childComments":` + kids + `}`
	}
	tree := reply(2, "bob", "["+reply(3, "cat", "["+reply(4, "dan", "["+reply(5, "eve", "null")+"]")+"]")+"]")
	body := `{"data":{"Thread":{"id":9,"title":"[Spoilers] Show - Episode 3 Discussion","body":"hi","replyCount":4,"viewCount":70,"createdAt":1,"siteUrl":"https://anilist.co/forum/thread/9","user":{"name":"op","avatar":{"medium":"a"}}},
		"Page":{"pageInfo":{"hasNextPage":true},"threadComments":[` + reply(1, "ann", "["+tree+"]") + `]}}}`
	c, n, vars := fakeGraphQL(t, body)

	p, err := c.Thread(context.Background(), 9, 2)
	if err != nil {
		t.Fatal(err)
	}
	if v := *vars.Load(); v["page"] != float64(2) || v["id"] != float64(9) {
		t.Fatalf("variables %v", *vars.Load())
	}
	if p.Thread.Title == "" || p.Thread.User.Name != "op" || p.Thread.Views != 70 || !p.HasNextPage {
		t.Fatalf("thread %+v", p)
	}
	if len(p.Comments) != 1 {
		t.Fatalf("comments %+v", p.Comments)
	}
	got := []string{}
	for _, r := range p.Comments[0].Replies {
		got = append(got, r.User.Name+"@"+r.ReplyTo)
	}
	// bob answers the top-level comment, cat and dan answer replies; eve sits
	// four levels down and is cut
	if strings.Join(got, ",") != "bob@,cat@bob,dan@cat" {
		t.Fatalf("replies %v", got)
	}

	if _, err := c.Thread(context.Background(), 9, 2); err != nil || n.Load() != 1 {
		t.Fatalf("second read should hit the cache: %d requests, %v", n.Load(), err)
	}
}

func TestThreadClipsBodiesAndMissing(t *testing.T) {
	long := strings.Repeat("ä", threadMaxBody)
	body := `{"data":{"Thread":{"id":1,"title":"t","body":"` + long + `","user":{"name":"x"}},"Page":{"pageInfo":{},"threadComments":[]}}}`
	c, _, _ := fakeGraphQL(t, body)
	p, err := c.Thread(context.Background(), 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Thread.Body) > threadMaxBody+8 || !strings.HasSuffix(p.Thread.Body, "…") {
		t.Fatalf("body not clipped: %d bytes", len(p.Thread.Body))
	}
	if p.Comments == nil {
		t.Fatal("comments must be an empty list, not null")
	}

	c2, _, _ := fakeGraphQL(t, `{"data":{"Thread":null,"Page":{"threadComments":[]}}}`)
	if _, err := c2.Thread(context.Background(), 2, 1); err == nil {
		t.Fatal("a missing thread must be an error")
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }
