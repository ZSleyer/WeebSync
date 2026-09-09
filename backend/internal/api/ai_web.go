package api

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/ai"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
)

// The web tools: a search through a SearXNG instance the admin names, and a
// page reader. Both are optional - the user switches them on per chat from
// the composer's add menu, and research mode turns both on with a longer
// leash of rounds and a brief for a report.

// aiWebTools are handed to the model only when the request asks for them.
var aiWebTools = []ai.Tool{
	fn("web_search", "Search the web for current information the other tools cannot know: news, release dates, reviews, what a title is about. Returns titles, urls and snippets; open a result with fetch_page when the snippet is not enough.", `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
	fn("fetch_page", "Read a web page as text (scripts and markup stripped, long pages cut). Use it on urls from web_search.", `{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}`),
}

// aiSearchURL is the SearXNG base the admin set, "" when web search is off.
func (s *Server) aiSearchURL() string {
	return strings.TrimRight(strings.TrimSpace(db.SettingOrEnv(s.DB, "ai_search_url", "AI_SEARCH_URL")), "/")
}

var aiWebHTTP = &http.Client{Timeout: 20 * time.Second}

type aiWebResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

// aiWebSearch asks SearXNG for the query and returns the first results.
func (s *Server) aiWebSearch(ctx context.Context, query, lang string) any {
	base := s.aiSearchURL()
	if base == "" {
		return map[string]any{"error": "web search is not configured"}
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return map[string]any{"error": "query missing"}
	}
	q := url.Values{"q": {query}, "format": {"json"}}
	if lang != "" {
		q.Set("language", lang)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/search?"+q.Encode(), nil)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	req.Header.Set("Accept", "application/json")
	resp, err := aiWebHTTP.Do(req)
	if err != nil {
		return map[string]any{"error": logSafe(err.Error())}
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return map[string]any{"error": fmt.Sprintf("search answered %d", resp.StatusCode)}
	}
	var out struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return map[string]any{"error": "search returned no json (is format=json allowed in its settings?)"}
	}
	results := []aiWebResult{}
	for _, r := range out.Results {
		if r.URL == "" {
			continue
		}
		results = append(results, aiWebResult{Title: excerpt(r.Title, 120), URL: r.URL, Snippet: excerpt(r.Content, 300)})
		if len(results) == 8 {
			break
		}
	}
	return map[string]any{"query": query, "results": results}
}

var (
	reScript = regexp.MustCompile(`(?is)<(script|style|noscript|svg|head)[^>]*>.*?</(script|style|noscript|svg|head)>`)
	reBlock  = regexp.MustCompile(`(?i)</?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|blockquote|pre)[^>]*>`)
	reTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpaces = regexp.MustCompile(`[ \t\r\f\v]+`)
	reBlank  = regexp.MustCompile(`\n{3,}`)
)

// htmlText turns a page into readable text: scripts, styles and markup out,
// block elements as line breaks, entities decoded, whitespace folded.
func htmlText(raw string) string {
	t := reScript.ReplaceAllString(raw, " ")
	t = reBlock.ReplaceAllString(t, "\n")
	t = reTag.ReplaceAllString(t, " ")
	t = html.UnescapeString(t)
	t = reSpaces.ReplaceAllString(t, " ")
	lines := strings.Split(t, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	t = strings.Join(lines, "\n")
	return strings.TrimSpace(reBlank.ReplaceAllString(t, "\n\n"))
}

const aiPageChars = 8000

// aiFetchPage reads one page as text; hosts the guard refuses stay closed.
func (s *Server) aiFetchPage(ctx context.Context, raw string) any {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return map[string]any{"error": "url must be absolute http(s)"}
	}
	if err := netguard.Allowed(u.Hostname()); err != nil {
		return map[string]any{"error": err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; WeebSync assistant)")
	req.Header.Set("Accept", "text/html,text/plain;q=0.9,*/*;q=0.5")
	resp, err := aiWebHTTP.Do(req)
	if err != nil {
		return map[string]any{"error": logSafe(err.Error())}
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return map[string]any{"error": fmt.Sprintf("page answered %d", resp.StatusCode)}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	text := string(body)
	if ct := resp.Header.Get("Content-Type"); strings.Contains(ct, "html") || strings.Contains(strings.ToLower(text[:min(len(text), 512)]), "<html") {
		text = htmlText(text)
	}
	cut := false
	if len(text) > aiPageChars {
		text, cut = text[:aiPageChars], true
	}
	return map[string]any{"url": u.String(), "text": text, "truncated": cut, "chars": len(text)}
}
