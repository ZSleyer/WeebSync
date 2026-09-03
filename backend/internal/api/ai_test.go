package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/ai"
	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// fakeProvider answers each chat round with the next scripted reply: either
// a tool call (name + arguments) or plain text. It records what it was sent.
type fakeProvider struct {
	*httptest.Server
	round    atomic.Int32
	script   []fakeReply
	requests []ai.Message
}

type fakeReply struct {
	tool string
	args string
	text string
}

func newFakeProvider(t *testing.T, script ...fakeReply) *fakeProvider {
	t.Helper()
	fp := &fakeProvider{script: script}
	fp.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var req struct {
			Messages []ai.Message `json:"messages"`
			Tools    []ai.Tool    `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		fp.requests = req.Messages
		if len(req.Tools) == 0 {
			http.Error(w, "no tools declared", 400)
			return
		}
		i := int(fp.round.Add(1)) - 1
		if i >= len(fp.script) {
			http.Error(w, "script exhausted", 500)
			return
		}
		rep := fp.script[i]
		w.Header().Set("Content-Type", "text/event-stream")
		if rep.tool != "" {
			args, _ := json.Marshal(rep.args)
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c%d\",\"type\":\"function\",\"function\":{\"name\":%q,\"arguments\":%s}}]}}]}\n\n", i, rep.tool, args)
		} else {
			// two deltas, so the test sees streaming rather than one blob
			half := len(rep.text) / 2
			for _, part := range []string{rep.text[:half], rep.text[half:]} {
				b, _ := json.Marshal(part)
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", b)
			}
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(fp.Close)
	return fp
}

func setupAiTest(t *testing.T, fp *fakeProvider) (*http.ServeMux, *Server, *http.Cookie) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, '/anime/Frieren', '/anime', 'Frieren', 1)`)
	d.Exec(`INSERT INTO remote_index (server_id, path, parent, name, is_dir) VALUES (1, '/anime/Frieren/ep1.mkv', '/anime/Frieren', 'ep1.mkv', 0)`)
	if fp != nil {
		db.SetSetting(d, "ai_base_url", fp.URL+"/v1")
		db.SetSetting(d, "ai_model", "fake")
	}
	s := &Server{DB: d, Anilist: anilist.New(d), AI: ai.New(d), DownloadRoot: t.TempDir()}
	mux := http.NewServeMux()
	s.Register(mux)
	return mux, s, cookieForUser(t, d, 1)
}

// events splits an SSE body into its decoded JSON lines.
func events(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
			t.Fatalf("bad event %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

func types(evs []map[string]any) string {
	var ts []string
	for _, e := range evs {
		ts = append(ts, e["type"].(string))
	}
	return strings.Join(ts, ",")
}

func TestAiUnconfiguredDegrades(t *testing.T) {
	mux, _, c := setupAiTest(t, nil)
	rec := doReq(mux, "GET", "/api/ai/status", "", c)
	if rec.Code != 200 || !jsonHas(rec.Body.Bytes(), `"configured":false`) {
		t.Fatalf("status: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"hi"}]}`, c)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("chat without config: %d %s", rec.Code, rec.Body)
	}
}

func TestAiChatToolLoopProposesExistingFolder(t *testing.T) {
	fp := newFakeProvider(t,
		fakeReply{tool: "search_remote", args: `{"query":"Frieren"}`},
		fakeReply{tool: "propose", args: `{"kind":"watch","serverId":1,"remotePath":"/anime/Frieren","title":"Frieren"}`},
		fakeReply{text: "Proposed an auto-sync for Frieren."},
	)
	mux, _, c := setupAiTest(t, fp)
	rec := doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"sync Frieren for me"}]}`, c)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body)
	}
	evs := events(t, rec.Body.String())
	if got := types(evs); got != "tool,tool,proposal,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	p := evs[2]
	if p["kind"] != "watch" || p["serverId"] != float64(1) || p["remotePath"] != "/anime/Frieren" || p["serverName"] != "srv" {
		t.Errorf("proposal: %v", p)
	}
	fields := p["fields"].(map[string]any)
	if fields["remotePath"] != "/anime/Frieren" || fields["titleOverride"] != "Frieren" || fields["mode"] != "template" {
		t.Errorf("fields: %v", fields)
	}
	// the model saw the search result and the vetted proposal as tool messages
	var toolMsgs []string
	for _, m := range fp.requests {
		if m.Role == "tool" {
			toolMsgs = append(toolMsgs, m.Content)
		}
	}
	if len(toolMsgs) != 2 || !strings.Contains(toolMsgs[0], `"/anime/Frieren"`) || !strings.Contains(toolMsgs[1], `"ok":true`) {
		t.Errorf("tool messages: %v", toolMsgs)
	}
	if fp.requests[0].Role != "system" || !strings.Contains(fp.requests[0].Content, "WeebSync") {
		t.Errorf("system prompt missing: %+v", fp.requests[0])
	}
}

func TestAiProposeRejectsInventedPathAndDuplicateWatch(t *testing.T) {
	fp := newFakeProvider(t,
		fakeReply{tool: "propose", args: `{"kind":"sync","serverId":1,"remotePath":"/anime/Made Up","title":"Made Up"}`},
		fakeReply{tool: "propose", args: `{"kind":"watch","serverId":1,"remotePath":"/anime/Frieren","title":"Frieren"}`},
		fakeReply{text: "Sorry."},
	)
	mux, s, c := setupAiTest(t, fp)
	s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path) VALUES (1, 1, '/anime/Frieren', 'x')`)
	rec := doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"go"}]}`, c)
	evs := events(t, rec.Body.String())
	if got := types(evs); got != "tool,tool,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	var reasons []string
	for _, m := range fp.requests {
		if m.Role == "tool" {
			if !strings.Contains(m.Content, `"ok":false`) {
				t.Errorf("expected rejection, got %s", m.Content)
			}
			reasons = append(reasons, m.Content)
		}
	}
	if len(reasons) != 2 || !strings.Contains(reasons[0], "does not exist") || !strings.Contains(reasons[1], "already exists") {
		t.Errorf("reasons: %v", reasons)
	}
}

func TestAiProposeUpgradeChecksGain(t *testing.T) {
	fp := newFakeProvider(t,
		fakeReply{tool: "propose", args: `{"kind":"upgrade","serverId":1,"remotePath":"/anime/Frieren","title":"Frieren","upgradeKey":"unit:x:1"}`},
		fakeReply{tool: "propose", args: `{"kind":"upgrade","serverId":1,"remotePath":"/anime/Frieren","title":"Frieren","upgradeKey":"unit:x:1"}`},
		fakeReply{text: "ok"},
	)
	mux, s, c := setupAiTest(t, fp)
	// user only cares about resolution; the remote copy adds a dub but no pixels
	s.DB.Exec(`UPDATE users SET upgrade_dims = 'res' WHERE id = 1`)
	blob := func(res int) string {
		b, _ := json.Marshal(SuggestionsResponse{Upgrades: []UpgradeSuggestion{{
			Key: "unit:x:1", Title: "Frieren", Season: 1,
			From:    UpgradeVariant{Folder: "/local/Frieren", ResRank: 1080, Dub: []string{"Jap"}, Sub: []string{"Ger"}, Probed: 1},
			To:      UpgradeVariant{ServerID: 1, Folder: "/anime/Frieren", ResRank: res, Dub: []string{"Jap", "Ger"}, Sub: []string{"Ger"}, Probed: 1},
			Options: []UpgradeVariant{{ServerID: 1, Folder: "/anime/Frieren", ResRank: res, Dub: []string{"Jap", "Ger"}, Sub: []string{"Ger"}, Probed: 1}},
			Sync:    SyncPlan{LocalPath: "/local/Frieren", Template: "S01E{episode}"},
		}}})
		return string(b)
	}
	s.cacheSet("suggestions:1", blob(1080))
	// second call happens after the first tool result; swap the blob in between
	// by answering the first proposal, then upgrading the cached copy
	rec := doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"better?"}]}`, c)
	evs := events(t, rec.Body.String())
	// both rounds ran against the same 1080p blob: nothing improves res → no proposal
	if got := types(evs); got != "tool,tool,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	for _, m := range fp.requests {
		if m.Role == "tool" && !strings.Contains(m.Content, "improves none") {
			t.Errorf("expected axis rejection: %s", m.Content)
		}
	}

	// now the remote copy is 4K: proposal goes through, carrying the sync plan
	fp.round.Store(0)
	s.cacheSet("suggestions:1", blob(2160))
	rec = doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"better?"}]}`, c)
	evs = events(t, rec.Body.String())
	if got := types(evs); got != "tool,proposal,tool,proposal,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	p := evs[1]
	fields := p["fields"].(map[string]any)
	if p["kind"] != "upgrade" || fields["localPath"] != "/local/Frieren" || fields["template"] != "S01E{episode}" {
		t.Errorf("upgrade proposal: %v", p)
	}
	if info := fmt.Sprint(p["info"]); !strings.Contains(info, "1080p → 4K") {
		t.Errorf("info: %s", info)
	}
}

func TestAiProposeRefusesFolderMatchedToAnotherTitle(t *testing.T) {
	fp := newFakeProvider(t,
		fakeReply{tool: "propose", args: `{"kind":"watch","serverId":1,"remotePath":"/anime/Frieren","title":"One Piece"}`},
		fakeReply{text: "no"},
	)
	mux, s, c := setupAiTest(t, fp)
	s.DB.Exec(`INSERT INTO catalog_matches (server_id, folder, media_id, source) VALUES (1, '/anime/Frieren', 154587, 'anilist')`)
	m := anilist.Media{ID: 154587, Status: "FINISHED", Schema: anilist.MediaSchema}
	m.Title.Romaji = "Sousou no Frieren"
	m.Title.English = "Frieren: Beyond Journey's End"
	payload, _ := json.Marshal(m)
	s.cacheSet("media:154587", string(payload))
	rec := doReq(mux, "POST", "/api/ai/chat", `{"messages":[{"role":"user","content":"go"}]}`, c)
	evs := events(t, rec.Body.String())
	if got := types(evs); got != "tool,delta,delta,done" {
		t.Fatalf("event order %s: %s", got, rec.Body)
	}
	if !strings.Contains(fp.requests[len(fp.requests)-1].Content, "is matched to") {
		t.Errorf("reason: %s", fp.requests[len(fp.requests)-1].Content)
	}
}

func TestAnimeSeason(t *testing.T) {
	for _, tc := range []struct {
		month  int
		season string
	}{{1, "WINTER"}, {3, "WINTER"}, {4, "SPRING"}, {7, "SUMMER"}, {9, "SUMMER"}, {10, "FALL"}, {12, "FALL"}} {
		if s, _ := animeSeason(timeOf(2026, tc.month)); s != tc.season {
			t.Errorf("month %d: %s, want %s", tc.month, s, tc.season)
		}
	}
}

func timeOf(year, month int) time.Time {
	return time.Date(year, time.Month(month), 15, 12, 0, 0, 0, time.UTC)
}
