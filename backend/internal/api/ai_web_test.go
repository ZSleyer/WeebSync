package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// A fake SearXNG and a fake page: the search tool returns the results, the
// page tool the text without markup, and neither is offered to the model
// unless the request switched the web tools on.
func TestAiWebToolsSearchReadAndGate(t *testing.T) {
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search":
			if r.URL.Query().Get("format") != "json" || r.URL.Query().Get("q") != "frieren season 3" {
				http.Error(w, "bad query", 400)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{
				{"title": "Frieren S3 announced", "url": "http://x.test/news", "content": "The third season airs in 2027."},
				{"title": "no url", "content": "dropped"},
			}})
		case "/news":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(`<html><head><title>t</title><style>p{}</style></head><body><script>x()</script><h1>Frieren</h1><p>Season &amp; three<br>airs in 2027.</p></body></html>`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(web.Close)

	fp := newFakeProvider(t,
		fakeReply{tool: "web_search", args: `{"query":"frieren season 3"}`},
		fakeReply{tool: "fetch_page", args: `{"url":"` + web.URL + `/news"}`},
		fakeReply{text: "Season 3 airs in 2027 (http://x.test/news)."},
	)
	mux, s, c := setupAiTest(t, fp)
	db.SetSetting(s.DB, "ai_search_url", web.URL)

	// status says the search is there
	if rec := doReq(mux, "GET", "/api/ai/status", "", c); !strings.Contains(rec.Body.String(), `"webSearch":true`) {
		t.Errorf("status: %s", rec.Body)
	}
	rec := doReq(mux, "POST", "/api/ai/chat", `{"tools":["web_search"],"messages":[{"role":"user","content":"when is frieren s3?"}]}`, c)
	evs := events(t, rec.Body.String())
	if got := types(evs); got != "tool,tool_done,tool,tool_done,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	var toolMsgs []string
	for _, m := range fp.requests {
		if m.Role == "tool" {
			toolMsgs = append(toolMsgs, m.Content)
		}
	}
	if len(toolMsgs) != 2 || !strings.Contains(toolMsgs[0], `"http://x.test/news"`) || strings.Contains(toolMsgs[0], "dropped") {
		t.Errorf("search result: %v", toolMsgs)
	}
	var page struct {
		Text string `json:"text"`
	}
	if len(toolMsgs) == 2 {
		json.Unmarshal([]byte(toolMsgs[1]), &page)
	}
	if page.Text != "Frieren\n\nSeason & three\nairs in 2027." {
		t.Errorf("page text: %q", page.Text)
	}
	if evs[1]["stats"].(map[string]any)["count"] != float64(1) || evs[3]["stats"].(map[string]any)["chars"] == nil {
		t.Errorf("stats: %v %v", evs[1], evs[3])
	}
	// the model saw the web tools only because the request asked for them
	if !strings.Contains(string(fp.raw), `"name":"web_search"`) {
		t.Errorf("web tools missing from the offer")
	}
	fp.round.Store(0)
	fp.script = []fakeReply{{text: "plain"}}
	doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"hi"}]}`, c)
	if strings.Contains(string(fp.raw), `"name":"web_search"`) {
		t.Errorf("web tools offered without being switched on")
	}
	// research mode briefs the model and turns the tools on by itself
	fp.round.Store(0)
	doReq(mux, "POST", "/api/ai/chat", `{"mode":"research","messages":[{"role":"user","content":"hi"}]}`, c)
	if !strings.Contains(string(fp.raw), `"name":"fetch_page"`) || !strings.Contains(fp.requests[0].Content, "Research mode") {
		t.Errorf("research mode: tools or brief missing")
	}
}

func TestHtmlText(t *testing.T) {
	got := htmlText("<div>A<script>bad()</script></div><p>B &lt; C</p>\n\n\n<ul><li>one</li><li>two</li></ul>")
	if got != "A\n\nB < C\n\none\n\ntwo" {
		t.Errorf("%q", got)
	}
}
