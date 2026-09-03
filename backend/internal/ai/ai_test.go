package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestReadStreamMergesToolCallFragments(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"Hel"}}]}`,
		``,
		`data: {"choices":[{"delta":{"content":"lo"}}]}`,
		`data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}`,
		`: keepalive`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_","arguments":""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"remote","arguments":"{\"que"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"my_watches","arguments":"{}"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\":\"x\"}"}}]}}]}`,
		`data: [DONE]`,
		`data: {"choices":[{"delta":{"content":"after done, ignored"}}]}`,
	}, "\n")
	var deltas, reasons []string
	msg, err := readStream(strings.NewReader(body), func(d Delta) {
		if d.Reasoning != "" {
			reasons = append(reasons, d.Reasoning)
		} else {
			deltas = append(deltas, d.Text)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Content != "Hello" || strings.Join(deltas, "|") != "Hel|lo" || strings.Join(reasons, "") != "hmm" {
		t.Errorf("content %q deltas %v reasons %v", msg.Content, deltas, reasons)
	}
	if len(msg.ToolCalls) != 2 {
		t.Fatalf("tool calls: %+v", msg.ToolCalls)
	}
	if c := msg.ToolCalls[0]; c.ID != "call_1" || c.Function.Name != "search_remote" || c.Function.Arguments != `{"query":"x"}` {
		t.Errorf("call 0: %+v", c)
	}
	if c := msg.ToolCalls[1]; c.ID != "call_2" || c.Function.Name != "my_watches" {
		t.Errorf("call 1: %+v", c)
	}
}

func TestReadStreamProviderError(t *testing.T) {
	_, err := readStream(strings.NewReader(`data: {"error":{"message":"model not found"}}`+"\n"), nil)
	if err == nil || !strings.Contains(err.Error(), "model not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestStreamAndPingAgainstFakeProvider(t *testing.T) {
	var gotAuth, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/v1/models":
			w.Write([]byte(`{"data":[{"id":"test-model"},{"id":"other"}]}`))
		case "/v1/chat/completions":
			var req struct {
				Model  string `json:"model"`
				Stream bool   `json:"stream"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !req.Stream {
				http.Error(w, "bad request", 400)
				return
			}
			gotModel = req.Model
			w.Header().Set("Content-Type", "text/event-stream")
			w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"))
		default:
			http.Error(w, "unauthorized", 401)
		}
	}))
	defer srv.Close()

	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	c := New(d)
	if c.Enabled() {
		t.Fatal("enabled without settings")
	}
	if err := c.Ping(context.Background()); err == nil {
		t.Fatal("ping without config must fail")
	}
	db.SetSetting(d, "ai_base_url", srv.URL+"/v1/")
	db.SetSetting(d, "ai_model", "test-model")
	db.SetSetting(d, "ai_api_key", "sk-test")
	if !c.Enabled() {
		t.Fatal("not enabled")
	}
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if gotAuth != "Bearer sk-test" {
		t.Errorf("auth header %q", gotAuth)
	}
	if ids, err := c.Models(context.Background()); err != nil || strings.Join(ids, ",") != "test-model,other" {
		t.Fatalf("models: %v %v", ids, err)
	}
	msg, err := c.Stream(context.Background(), "", []Message{{Role: "user", Content: "hi"}}, nil, nil)
	if err != nil || msg.Content != "ok" || gotModel != "test-model" {
		t.Fatalf("stream: %v %+v model %q", err, msg, gotModel)
	}
	if _, err := c.Stream(context.Background(), "other", []Message{{Role: "user", Content: "hi"}}, nil, nil); err != nil || gotModel != "other" {
		t.Fatalf("stream override: %v model %q", err, gotModel)
	}

	// a non-2xx answer surfaces the provider's text
	db.SetSetting(d, "ai_base_url", srv.URL+"/nope")
	if err := c.Ping(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("ping err = %v", err)
	}
}
