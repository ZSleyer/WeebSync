// Package ai talks to an OpenAI-compatible chat endpoint (LiteLLM, OpenRouter,
// Ollama's /v1, vLLM, ...) configured by the admin: base URL, optional API key,
// model. Everything is optional - an unconfigured client reports Enabled()
// false and the assistant stays out of the UI.
package ai

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
)

type Client struct {
	DB   *sql.DB
	HTTP *http.Client
}

// New returns a client that reads its settings per request, so a change on
// the settings page takes effect without a restart. The long timeout covers
// a slow local model streaming a full answer; the guard keeps a user-supplied
// URL away from cloud-metadata and link-local targets (LAN stays allowed -
// that is where LiteLLM/Ollama live).
func New(d *sql.DB) *Client {
	return &Client{DB: d, HTTP: netguard.Client(5 * time.Minute)}
}

func (c *Client) baseURL() string {
	return strings.TrimRight(strings.TrimSpace(db.SettingOrEnv(c.DB, "ai_base_url", "AI_BASE_URL")), "/")
}

func (c *Client) apiKey() string {
	return strings.TrimSpace(secret.SettingOrEnv(c.DB, "ai_api_key", "AI_API_KEY"))
}

// Model is the configured model id, sent verbatim in every request.
func (c *Client) Model() string {
	return strings.TrimSpace(db.SettingOrEnv(c.DB, "ai_model", "AI_MODEL"))
}

// Enabled reports whether a base URL and a model are configured. The key is
// optional: a local Ollama or LiteLLM without auth needs none.
func (c *Client) Enabled() bool { return c.baseURL() != "" && c.Model() != "" }

// Ping checks the endpoint by listing its models - every OpenAI-compatible
// server answers GET /models, and it exercises the key without spending tokens.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Models(ctx)
	return err
}

// Models lists the ids the endpoint serves, in the order it reports them.
// ModelInfo is one model the endpoint serves. Vision says whether it reads
// pictures: nil when the endpoint does not say, which the standard model list
// never does - OpenRouter's list names input modalities, LiteLLM's model
// info carries supports_vision for the models it knows.
type ModelInfo struct {
	ID     string
	Vision *bool
}

// Models lists what the endpoint serves.
func (c *Client) Models(ctx context.Context) ([]ModelInfo, error) {
	if !c.Enabled() {
		return nil, errors.New("ai: not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL()+"/models", nil)
	if err != nil {
		return nil, err
	}
	c.auth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, httpErr(resp)
	}
	var out struct {
		Data []struct {
			ID           string `json:"id"`
			Architecture struct {
				InputModalities []string `json:"input_modalities"`
			} `json:"architecture"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("ai: models: %w", err)
	}
	models := make([]ModelInfo, 0, len(out.Data))
	open := false
	for _, m := range out.Data {
		if m.ID == "" {
			continue
		}
		mi := ModelInfo{ID: m.ID}
		if len(m.Architecture.InputModalities) > 0 {
			v := slices.Contains(m.Architecture.InputModalities, "image")
			mi.Vision = &v
		} else {
			open = true
		}
		models = append(models, mi)
	}
	if open {
		c.litellmVision(ctx, models)
	}
	return models, nil
}

// litellmVision fills the vision flag from LiteLLM's model info for the
// models the list left open. Any other endpoint answers 404 here, which is
// the same as saying nothing.
func (c *Client) litellmVision(ctx context.Context, models []ModelInfo) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL()+"/model/info", nil)
	if err != nil {
		return
	}
	c.auth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return
	}
	var out struct {
		Data []struct {
			ModelName string `json:"model_name"`
			ModelInfo struct {
				SupportsVision *bool `json:"supports_vision"`
			} `json:"model_info"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out) != nil {
		return
	}
	known := map[string]*bool{}
	for _, m := range out.Data {
		if m.ModelInfo.SupportsVision != nil {
			known[m.ModelName] = m.ModelInfo.SupportsVision
		}
	}
	for i := range models {
		if models[i].Vision == nil {
			models[i].Vision = known[models[i].ID]
		}
	}
}

func (c *Client) auth(req *http.Request) {
	req.Header.Set("Accept", "application/json")
	if k := c.apiKey(); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
}

// httpErr turns a non-2xx response into an error carrying a short, log-safe
// excerpt of the body - providers put the useful part ("model not found",
// "invalid api key") there.
func httpErr(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	msg := strings.Join(strings.Fields(string(b)), " ")
	if len(msg) > 300 {
		msg = msg[:300]
	}
	if msg == "" {
		return fmt.Errorf("ai: HTTP %d", resp.StatusCode)
	}
	return fmt.Errorf("ai: HTTP %d: %s", resp.StatusCode, msg)
}

// Message is one chat turn in the OpenAI wire format.
type Message struct {
	Role       string     `json:"role"` // system | user | assistant | tool
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"` // role tool: the call this answers
	// Images are data URLs attached to a user message; they go out as the
	// content parts a vision model reads, next to the text
	Images []string `json:"-"`
}

// contentPart is one piece of a multimodal message.
type contentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

// MarshalJSON writes the content as parts when images are attached: the
// plain string form otherwise, which every endpoint understands.
func (m Message) MarshalJSON() ([]byte, error) {
	type plain Message
	if len(m.Images) == 0 {
		return json.Marshal(plain(m))
	}
	parts := []contentPart{{Type: "text", Text: m.Content}}
	for _, u := range m.Images {
		parts = append(parts, contentPart{Type: "image_url", ImageURL: &imageURL{URL: u}})
	}
	return json.Marshal(struct {
		Role    string        `json:"role"`
		Content []contentPart `json:"content"`
	}{m.Role, parts})
}

// ToolCall is one function the model asked us to run.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"` // "function"
	Function FunctionCall `json:"function"`
}

// FunctionCall names the tool and carries its arguments as a JSON string.
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Tool declares one callable function to the model.
type Tool struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

// ToolFunction is the tool's name, description and JSON-schema parameters.
type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// Delta is one streamed fragment: answer text, or the model's reasoning
// (reasoning_content / reasoning, whichever the provider streams).
type Delta struct {
	Text      string
	Reasoning string
}

// Stream sends one chat completion request with stream=true, hands every
// fragment to onDelta as it arrives and returns the assembled assistant
// message, tool calls included. Tool-call fragments arrive spread over many
// chunks and are keyed by index; they are merged here so the caller sees
// whole calls. An empty model means the configured default.
func (c *Client) Stream(ctx context.Context, model string, messages []Message, tools []Tool, onDelta func(Delta)) (Message, error) {
	if !c.Enabled() {
		return Message{}, errors.New("ai: not configured")
	}
	if model == "" {
		model = c.Model()
	}
	payload := map[string]any{
		"model":    model,
		"messages": messages,
		"stream":   true,
	}
	if len(tools) > 0 {
		payload["tools"] = tools
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL()+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	c.auth(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Message{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return Message{}, httpErr(resp)
	}
	limited := &io.LimitedReader{R: resp.Body, N: 16<<20 + 1}
	out, err := readStream(limited, onDelta)
	if err == nil && limited.N == 0 {
		return Message{}, fmt.Errorf("ai: response too large")
	}
	return out, err
}

// chunk is the slice of a streamed completion chunk we act on.
type chunk struct {
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"` // DeepSeek, llama.cpp, LiteLLM
			Reasoning        string `json:"reasoning"`         // OpenRouter
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
}

// readStream parses the SSE body of a streamed completion.
func readStream(r io.Reader, onDelta func(Delta)) (Message, error) {
	out := Message{Role: "assistant"}
	var content strings.Builder
	calls := map[int]*ToolCall{}
	order := []int{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var ch chunk
		if json.Unmarshal([]byte(data), &ch) != nil {
			continue // keepalives and provider extras are not ours to fail on
		}
		if ch.Error != nil {
			return Message{}, fmt.Errorf("ai: %s", ch.Error.Message)
		}
		for _, choice := range ch.Choices {
			if choice.Delta.Content != "" {
				content.WriteString(choice.Delta.Content)
				if onDelta != nil {
					onDelta(Delta{Text: choice.Delta.Content})
				}
			}
			// LiteLLM mirrors OpenRouter's reasoning into reasoning_content,
			// so a chunk can carry the same text under both names: one wins
			r := choice.Delta.ReasoningContent
			if r == "" {
				r = choice.Delta.Reasoning
			}
			if r != "" && onDelta != nil {
				onDelta(Delta{Reasoning: r})
			}
			for _, tc := range choice.Delta.ToolCalls {
				call, ok := calls[tc.Index]
				if !ok {
					call = &ToolCall{Type: "function"}
					calls[tc.Index] = call
					order = append(order, tc.Index)
				}
				if tc.ID != "" {
					call.ID = tc.ID
				}
				if tc.Function.Name != "" {
					call.Function.Name += tc.Function.Name
				}
				call.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := sc.Err(); err != nil {
		return Message{}, err
	}
	out.Content = content.String()
	for _, i := range order {
		out.ToolCalls = append(out.ToolCalls, *calls[i])
	}
	return out, nil
}
