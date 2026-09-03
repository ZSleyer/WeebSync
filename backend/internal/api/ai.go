package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/ai"
	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/match"
)

// The assistant is a chat over the user's own data: lists, suggestions,
// upgrades, the remote index. The model never writes anything. It reads
// through the tools below and may PROPOSE a watch, a one-off sync or an
// upgrade; a proposal is vetted here against the same data the model saw
// (does the folder exist, does the upgrade really improve an enabled axis,
// does the folder belong to the title it claims) and then handed to the UI
// as a card that opens the ordinary watch dialog. Whatever gets created goes
// through POST /api/watches or /api/downloads/sync like everything else.

// aiStatusResponse reports whether the assistant is available. Connected and
// Error are only filled for a forced check (settings page); the nav gate asks
// without force and never triggers a network call.
type aiStatusResponse struct {
	Configured bool   `json:"configured"`
	Model      string `json:"model,omitempty"`
	Connected  bool   `json:"connected,omitempty"`
	Error      string `json:"error,omitempty"`
}

// handleAiStatus reports the assistant's configuration state.
//
//	@Summary		Assistant status
//	@Description	Whether an assistant endpoint is configured; force=1 also tests the connection. Always 200.
//	@Tags			Assistant
//	@Produce		json
//	@Param			force	query		bool	false	"Also contact the endpoint"
//	@Success		200		{object}	aiStatusResponse
//	@Security		CookieAuth
//	@Router			/api/ai/status [get]
func (s *Server) handleAiStatus(w http.ResponseWriter, r *http.Request) {
	if s.AI == nil || !s.AI.Enabled() {
		writeJSON(w, http.StatusOK, aiStatusResponse{})
		return
	}
	out := aiStatusResponse{Configured: true, Model: s.AI.Model()}
	if r.URL.Query().Get("force") != "" {
		if err := s.AI.Ping(r.Context()); err != nil {
			out.Error = logSafe(err.Error())
		} else {
			out.Connected = true
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// aiChatMessage is one prior turn the client sends back; only user and
// assistant turns are accepted, the server rebuilds everything else.
type aiChatMessage struct {
	Role    string `json:"role" example:"user"`
	Content string `json:"content"`
}

// aiChatRequest is the conversation so far, newest last. Model overrides the
// configured default for this request (a pick from /api/ai/models).
type aiChatRequest struct {
	Messages []aiChatMessage `json:"messages"`
	Model    string          `json:"model,omitempty"`
}

// aiModelsResponse lists what the endpoint serves and which id is the default.
type aiModelsResponse struct {
	Models  []string `json:"models"`
	Default string   `json:"default"`
	Error   string   `json:"error,omitempty"`
}

// handleAiModels lists the endpoint's models for the pickers.
//
//	@Summary		Assistant models
//	@Description	Lists the model ids the configured endpoint serves plus the default. Always 200; an unreachable endpoint reports error with an empty list.
//	@Tags			Assistant
//	@Produce		json
//	@Success		200	{object}	aiModelsResponse
//	@Security		CookieAuth
//	@Router			/api/ai/models [get]
func (s *Server) handleAiModels(w http.ResponseWriter, r *http.Request) {
	out := aiModelsResponse{Models: []string{}}
	if s.AI == nil || !s.AI.Enabled() {
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.Default = s.AI.Model()
	ids, err := s.AI.Models(r.Context())
	if err != nil {
		out.Error = logSafe(err.Error())
	} else {
		out.Models = ids
	}
	writeJSON(w, http.StatusOK, out)
}

// aiEvent is one line of the chat stream: answer text (delta), the model's
// reasoning (reasoning), a tool starting (tool: name + args) and finishing
// (tool_done: name + a result excerpt), a vetted proposal, an error, done.
type aiEvent struct {
	Type    string   `json:"type"` // delta | reasoning | tool | tool_done | proposal | cards | error | done
	Text    string   `json:"text,omitempty"`
	Name    string   `json:"name,omitempty"`
	Args    string   `json:"args,omitempty"`
	Result  string   `json:"result,omitempty"`
	Message string   `json:"message,omitempty"`
	Cards   []aiCard `json:"cards,omitempty"`
	*aiProposal
}

// aiCard is one recommended title as the chat shows it: the provider's
// media record (cover, description, trailer, score - what the catalog's
// detail dialog renders) plus the model's one-line reason.
type aiCard struct {
	Source string        `json:"source"` // anilist | tmdb:tv | tmdb:movie | tvdb
	Media  anilist.Media `json:"media"`
	Why    string        `json:"why,omitempty"`
}

// excerpt trims a tool payload to what a transcript can show.
func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// aiProposal is a vetted action the user can confirm. Fields is the watch
// dialog's form, prefilled; the dialog and the existing endpoints do the rest.
type aiProposal struct {
	Kind       string        `json:"kind"` // watch | sync | upgrade
	Title      string        `json:"title"`
	ServerID   int64         `json:"serverId"`
	ServerName string        `json:"serverName"`
	RemotePath string        `json:"remotePath"`
	Fields     aiWatchFields `json:"fields"`
	Info       []string      `json:"info,omitempty"`
	Unverified bool          `json:"unverified,omitempty"`
}

// aiWatchFields mirrors the frontend's WatchFields: what the watch dialog
// takes as its initial state.
type aiWatchFields struct {
	RemotePath      string `json:"remotePath"`
	LocalPath       string `json:"localPath"`
	Mode            string `json:"mode"`
	Template        string `json:"template"`
	Separator       string `json:"separator"`
	TitleOverride   string `json:"titleOverride"`
	Pattern         string `json:"pattern"`
	Replacement     string `json:"replacement"`
	Subfolder       bool   `json:"subfolder"`
	MediaID         int    `json:"mediaId"`
	MediaSource     string `json:"mediaSource"`
	FromEpisode     int    `json:"fromEpisode"`
	AiredMapping    bool   `json:"airedMapping"`
	RenameProvider  string `json:"renameProvider"`
	RenameOrdering  string `json:"renameOrdering"`
	RenameTitleLang string `json:"renameTitleLang"`
	RenameSeriesID  int    `json:"renameSeriesId"`
	WantDub         string `json:"wantDub"`
	WantSub         string `json:"wantSub"`
	PlexAudioLang   string `json:"plexAudioLang"`
	PlexSubLang     string `json:"plexSubLang"`
}

const (
	aiMaxHistory = 30 // turns kept from the client's history
	aiMaxRounds  = 6  // model↔tool round trips per request
)

// handleAiChat streams one assistant answer for the given conversation.
//
//	@Summary		Assistant chat
//	@Description	Streams the assistant's answer as server-sent events (JSON per line: delta, tool, proposal, error, done). The model only reads; proposals are vetted server-side and confirmed by the user in the watch dialog.
//	@Tags			Assistant
//	@Accept			json
//	@Produce		text/event-stream
//	@Param			body	body		aiChatRequest	true	"conversation so far"
//	@Success		200		{string}	string			"event stream"
//	@Failure		400		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Failure		503		{object}	ErrorResponse	"assistant not configured"
//	@Security		CookieAuth
//	@Router			/api/ai/chat [post]
func (s *Server) handleAiChat(w http.ResponseWriter, r *http.Request) {
	if s.AI == nil || !s.AI.Enabled() {
		writeErr(w, http.StatusServiceUnavailable, "assistant not configured")
		return
	}
	var in aiChatRequest
	if !readJSON(w, r, &in) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	u := auth.UserFrom(r.Context())
	model := strings.TrimSpace(in.Model)
	if len(model) > 200 {
		writeErr(w, http.StatusBadRequest, "model too long")
		return
	}
	msgs := []ai.Message{{Role: "system", Content: s.aiSystemPrompt(u.ID)}}
	hist := in.Messages
	if len(hist) > aiMaxHistory {
		hist = hist[len(hist)-aiMaxHistory:]
	}
	for _, m := range hist {
		if (m.Role == "user" || m.Role == "assistant") && strings.TrimSpace(m.Content) != "" {
			msgs = append(msgs, ai.Message{Role: m.Role, Content: m.Content})
		}
	}
	if len(msgs) == 1 || msgs[len(msgs)-1].Role != "user" {
		writeErr(w, http.StatusBadRequest, "last message must be from the user")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	var wmu sync.Mutex
	emit := func(ev aiEvent) {
		b, _ := json.Marshal(ev)
		wmu.Lock()
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		wmu.Unlock()
	}
	// a model thinking or a tool waiting on a provider can leave the line
	// silent for a while; proxies drop idle responses, so keep it warm
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				wmu.Lock()
				fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
				wmu.Unlock()
			}
		}
	}()
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	for round := 0; ; round++ {
		if round >= aiMaxRounds {
			emit(aiEvent{Type: "error", Message: "the assistant needed too many steps; ask more specifically"})
			break
		}
		reply, err := s.AI.Stream(ctx, model, msgs, aiTools, func(d ai.Delta) {
			if d.Reasoning != "" {
				emit(aiEvent{Type: "reasoning", Text: d.Reasoning})
			} else {
				emit(aiEvent{Type: "delta", Text: d.Text})
			}
		})
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				slog.Warn("assistant", "user", u.ID, "err", logSafe(err.Error()))
				emit(aiEvent{Type: "error", Message: logSafe(err.Error())})
			}
			return
		}
		if len(reply.ToolCalls) == 0 {
			break
		}
		msgs = append(msgs, reply)
		for _, call := range reply.ToolCalls {
			emit(aiEvent{Type: "tool", Name: call.Function.Name, Args: excerpt(call.Function.Arguments, 400)})
			out := s.aiTool(ctx, u.ID, call.Function.Name, call.Function.Arguments)
			if out.proposal != nil {
				emit(aiEvent{Type: "proposal", aiProposal: out.proposal})
			}
			if len(out.cards) > 0 {
				emit(aiEvent{Type: "cards", Cards: out.cards})
			}
			b, _ := json.Marshal(out.result)
			emit(aiEvent{Type: "tool_done", Name: call.Function.Name, Result: excerpt(string(b), 1500)})
			msgs = append(msgs, ai.Message{Role: "tool", ToolCallID: call.ID, Content: string(b)})
		}
	}
	emit(aiEvent{Type: "done"})
}

// aiSystemPrompt frames the model: what it is, what the tools mean, what it
// may never do, and which language to answer in.
func (s *Server) aiSystemPrompt(userID int64) string {
	now := time.Now()
	season, year := animeSeason(now)
	lang := "English"
	if s.userLocale(userID) == "de" {
		lang = "German"
	}
	return fmt.Sprintf(`You are the assistant inside WeebSync, a self-hosted app that keeps a media library in sync with the user's own remote servers (SFTP/FTP) and links it to AniList, TMDB, TVDB and Plex.
Today is %s. The current anime season is %s %d.
Answer in %s. Be concise. Plain text only: no markdown (no bold, headings or tables); short paragraphs and simple "-" bullet lists are fine.

You can only READ through the tools and PROPOSE actions; the user confirms every proposal in a dialog. Rules:
- Before each tool call, say in one short sentence what you are checking and why; that narration becomes the visible transcript.
- Recommend from the user's own data first (my_lists, suggestions, seasonal). Explain briefly why a title fits (genres, what they finished, score). When you recommend titles, also call recommend with their ids and reasons so the user gets cards to open; then keep the text short, the cards carry the details.
- Never recommend what the user already has: entries flagged owned (in the Plex library) or inAutoSync (an auto-sync keeps it current) are covered. Check the flags (or my_watches) before recommending; if the user asks about such a title, say it is already covered.
- Before proposing a watch or sync, find the folder with search_remote or take a candidate from suggestions/seasonal. Never invent server ids or paths.
- kind "watch" = auto-sync: keeps a remote folder in sync (for airing shows). kind "sync" = download once. kind "upgrade" = replace a local copy with a better remote copy; only from the upgrades tool, quoting its key and one of its option folders, and only when it improves an axis the user enabled. Say concretely what improves (resolution, dub, sub, selectable subtitles) and mention when the language data is unverified.
- Tools are called only through the tool-call interface, never written out as text in the answer.
- If propose returns ok:false, tell the user the reason; do not retry the same call.
- Do not claim something was created: a proposal is a card the user still has to confirm.`,
		now.Format("2006-01-02"), season, year, lang)
}

// animeSeason maps a date onto AniList's season naming.
func animeSeason(t time.Time) (string, int) {
	switch (int(t.Month()) - 1) / 3 {
	case 0:
		return "WINTER", t.Year()
	case 1:
		return "SPRING", t.Year()
	case 2:
		return "SUMMER", t.Year()
	}
	return "FALL", t.Year()
}

// aiTools declares the functions the model may call.
var aiTools = []ai.Tool{
	fn("my_lists", "The user's AniList list (status, progress, score) and plex.tv watchlist.", `{"type":"object","properties":{}}`),
	fn("suggestions", "WeebSync's own suggestions for this user: watchlist titles present on a server, community recommendations, trending, and incomplete seasons the library is missing (each with a refKey, remote candidates and a sync plan).", `{"type":"object","properties":{}}`),
	fn("upgrades", "Better remote copies of series the library already holds, with the quality of the local and the remote copy and which axes improve. Each has a key and option folders for propose(kind=upgrade).", `{"type":"object","properties":{}}`),
	fn("seasonal", "Anime of one broadcast season, most popular first, flagged with the user's list status, whether the library has it, and remote folders.", `{"type":"object","properties":{"season":{"type":"string","enum":["WINTER","SPRING","SUMMER","FALL"]},"year":{"type":"integer"}},"required":["season","year"]}`),
	fn("search_remote", "Search folders on the user's remote servers by words of a title. Returns server id, path and the folder's known quality.", `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
	fn("my_watches", "The user's existing auto-syncs.", `{"type":"object","properties":{}}`),
	fn("recommend", "Show the user cards for titles you recommend (cover, description, score, links). Call it with the ids you got from my_lists, suggestions or seasonal, each with a one-line reason. Up to 8 titles.", `{"type":"object","properties":{"titles":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"},"source":{"type":"string","enum":["anilist","tmdb:tv","tmdb:movie","tvdb"]},"why":{"type":"string"}},"required":["id"]}}},"required":["titles"]}`),
	fn("propose", "Propose an action for the user to confirm. kind: watch (auto-sync a remote folder), sync (download once), upgrade (replace a local copy; needs upgradeKey from upgrades and one of its option folders). refKey: from suggestions, when the folder came from there.", `{"type":"object","properties":{"kind":{"type":"string","enum":["watch","sync","upgrade"]},"serverId":{"type":"integer"},"remotePath":{"type":"string"},"title":{"type":"string"},"upgradeKey":{"type":"string"},"refKey":{"type":"string"}},"required":["kind","serverId","remotePath","title"]}`),
}

func fn(name, desc, params string) ai.Tool {
	return ai.Tool{Type: "function", Function: ai.ToolFunction{Name: name, Description: desc, Parameters: json.RawMessage(params)}}
}

// aiTool runs one tool for this user. The result goes back to the model; a
// proposal, when the call produced one, goes to the client.
// aiToolOut is what a tool hands back: the result for the model, plus what
// the client gets to see (a vetted proposal, recommendation cards).
type aiToolOut struct {
	result   any
	proposal *aiProposal
	cards    []aiCard
}

func (s *Server) aiTool(ctx context.Context, userID int64, name, rawArgs string) aiToolOut {
	var args struct {
		Titles []struct {
			ID     int    `json:"id"`
			Source string `json:"source"`
			Why    string `json:"why"`
		} `json:"titles"`
		Season     string `json:"season"`
		Year       int    `json:"year"`
		Query      string `json:"query"`
		Kind       string `json:"kind"`
		ServerID   int64  `json:"serverId"`
		RemotePath string `json:"remotePath"`
		Title      string `json:"title"`
		UpgradeKey string `json:"upgradeKey"`
		RefKey     string `json:"refKey"`
	}
	if rawArgs != "" {
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return aiToolOut{result: map[string]any{"error": "arguments must be a JSON object"}}
		}
	}
	switch name {
	case "my_lists":
		return aiToolOut{result: s.aiLists(userID)}
	case "suggestions":
		return aiToolOut{result: s.aiSuggestions(ctx, userID)}
	case "upgrades":
		return aiToolOut{result: s.aiUpgrades(ctx, userID)}
	case "seasonal":
		return aiToolOut{result: s.aiSeasonal(ctx, userID, strings.ToUpper(args.Season), args.Year)}
	case "search_remote":
		return aiToolOut{result: s.aiSearchRemote(userID, args.Query)}
	case "my_watches":
		return aiToolOut{result: s.aiWatches(userID)}
	case "recommend":
		// what the user already has is not a recommendation: dropped here
		// regardless of what the model asked for, and reported so it can say so
		have := s.aiHaveIndex(userID)
		cards := []aiCard{}
		missing := []int{}
		skipped := []map[string]any{}
		for i, t := range args.Titles {
			if i >= 8 {
				break
			}
			src := t.Source
			if src == "" {
				src = "anilist"
			}
			m := s.aiMedia(ctx, src, t.ID)
			if m == nil {
				missing = append(missing, t.ID)
				continue
			}
			switch {
			case have.inSync(*m, src):
				skipped = append(skipped, map[string]any{"id": t.ID, "title": aiTitle(*m), "reason": "already in an auto-sync"})
			case have.owned(*m, src):
				skipped = append(skipped, map[string]any{"id": t.ID, "title": aiTitle(*m), "reason": "already in the Plex library"})
			default:
				cards = append(cards, aiCard{Source: src, Media: *m, Why: excerpt(t.Why, 200)})
			}
		}
		res := map[string]any{"shown": len(cards)}
		if len(missing) > 0 {
			res["unknownIds"] = missing
		}
		if len(skipped) > 0 {
			res["skipped"] = skipped
			res["note"] = "skipped titles the user already has; do not recommend them, mention briefly that they are covered"
		}
		return aiToolOut{result: res, cards: cards}
	case "propose":
		p, reason := s.aiPropose(ctx, userID, args.Kind, args.ServerID, args.RemotePath, args.Title, args.UpgradeKey, args.RefKey)
		if p == nil {
			return aiToolOut{result: map[string]any{"ok": false, "reason": reason}}
		}
		return aiToolOut{result: map[string]any{"ok": true, "shown": true, "info": p.Info, "unverified": p.Unverified}, proposal: p}
	}
	return aiToolOut{result: map[string]any{"error": "unknown tool"}}
}

// aiMedia resolves one provider record for a card, from the cache or live,
// with the canonical display title set the way the catalog shows it.
func (s *Server) aiMedia(ctx context.Context, source string, id int) *anilist.Media {
	if id <= 0 {
		return nil
	}
	var m *anilist.Media
	var err error
	switch {
	case source == "anilist":
		m, err = s.Anilist.Media(ctx, id)
	case strings.HasPrefix(source, "tmdb:") && s.Tmdb != nil && s.Tmdb.Enabled():
		m, err = s.Tmdb.Media(ctx, strings.TrimPrefix(source, "tmdb:"), id)
	case source == "tvdb" && s.Tvdb != nil && s.Tvdb.Enabled():
		m, err = s.Tvdb.Media(ctx, id)
	}
	if err != nil || m == nil {
		return nil
	}
	m.Title.Preferred = displayTitle(*m, source)
	return m
}

// ── read tools ──

type aiListEntry struct {
	ID       int      `json:"id"`
	Title    string   `json:"title"`
	Year     int      `json:"year,omitempty"`
	Format   string   `json:"format,omitempty"`
	Status   string   `json:"status,omitempty"`
	Progress int      `json:"progress,omitempty"`
	Score    int      `json:"score,omitempty"`
	Genres   []string `json:"genres,omitempty"`
	// Owned: the Plex library holds it. InAutoSync: a watch keeps it in sync.
	// Neither is a recommendation candidate.
	Owned      bool `json:"owned,omitempty"`
	InAutoSync bool `json:"inAutoSync,omitempty"`
}

func aiTitle(m anilist.Media) string {
	switch {
	case m.Title.Preferred != "":
		return m.Title.Preferred
	case m.Title.English != "":
		return m.Title.English
	}
	return m.Title.Romaji
}

// aiHave answers "does the user already have this title": in an auto-sync
// (the watch's catalog match by id, else its title against the folder or
// override name) or in the Plex library. Built once per tool call so a list
// of a few hundred entries costs one query and one title index.
type aiHave struct {
	owned  func(anilist.Media, string) bool
	ids    map[string]bool // "source:id" of matched watch folders
	titles []string        // watch titles for the fold-key comparison
}

func (s *Server) aiHaveIndex(userID int64) aiHave {
	h := aiHave{owned: s.plexOwned(), ids: map[string]bool{}}
	rows, err := s.DB.Query(`SELECT w.remote_path, w.title_override, COALESCE(m.source, ''), COALESCE(m.media_id, 0)
		FROM watches w LEFT JOIN catalog_matches m ON m.server_id = w.server_id AND m.folder = w.remote_path
		WHERE w.user_id = ?`, userID)
	if err != nil {
		return h
	}
	defer rows.Close()
	for rows.Next() {
		var remotePath, override, source string
		var mediaID int
		if rows.Scan(&remotePath, &override, &source, &mediaID) != nil {
			continue
		}
		if mediaID != 0 {
			h.ids[source+":"+strconv.Itoa(mediaID)] = true
		}
		title := override
		if title == "" {
			title = match.GuessTitle(path.Base(remotePath))
		}
		h.titles = append(h.titles, title)
	}
	return h
}

// inSync reports whether an auto-sync already covers the media.
func (h aiHave) inSync(m anilist.Media, source string) bool {
	if h.ids[source+":"+strconv.Itoa(m.ID)] {
		return true
	}
	for _, t := range h.titles {
		for _, mt := range []string{m.Title.Romaji, m.Title.English} {
			if mt != "" && titlesAgree(t, mt) {
				return true
			}
		}
	}
	return false
}

// aiUserList is the user's AniList list, refreshed in the background when
// stale (the answer uses whatever is cached now).
func (s *Server) aiUserList(userID int64) []anilist.ListEntry {
	alID, token, err := s.anilistAccount(userID)
	if err != nil {
		return nil
	}
	var fetched string
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, fmt.Sprintf("alist2:%d", alID)).Scan(&fetched)
	if t, perr := time.Parse(sqliteTime, fetched); perr != nil || time.Since(t) > time.Hour {
		s.buildAnilistSuggestions(alID, token)
	}
	return s.Anilist.CachedUserList(alID)
}

func (s *Server) aiLists(userID int64) any {
	out := map[string]any{}
	have := s.aiHaveIndex(userID)
	list := s.aiUserList(userID)
	if list == nil {
		out["anilist"] = "no AniList account linked"
	} else {
		entries := make([]aiListEntry, 0, len(list))
		for i, e := range list {
			if i >= 300 {
				break
			}
			entries = append(entries, aiListEntry{ID: e.Media.ID, Title: aiTitle(e.Media), Year: e.Media.SeasonYear,
				Format: e.Media.Format, Status: e.Status, Progress: e.Progress, Score: e.Score, Genres: e.Media.Genres,
				Owned: have.owned(e.Media, "anilist"), InAutoSync: have.inSync(e.Media, "anilist")})
		}
		out["anilist"] = entries
	}
	bySrc, bySeries := s.seriesProviderMaps()
	plex := []aiListEntry{}
	for _, it := range s.plexWatchlistItems(userID, bySrc, bySeries) {
		plex = append(plex, aiListEntry{ID: it.Media.ID, Title: it.Title, Year: it.Year, Format: it.Media.Format,
			Owned: have.owned(it.Media, "anilist"), InAutoSync: have.inSync(it.Media, "anilist")})
	}
	out["plexWatchlist"] = plex
	return out
}

type aiCandidate struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
}

type aiSugEntry struct {
	RefKey     string        `json:"refKey"`
	Title      string        `json:"title"`
	Year       int           `json:"year,omitempty"`
	Category   string        `json:"category"`
	Status     string        `json:"status,omitempty"`
	Progress   int           `json:"progress,omitempty"`
	Have       int           `json:"have,omitempty"`
	Need       int           `json:"need,omitempty"`
	Because    []string      `json:"because,omitempty"`
	Genres     []string      `json:"genres,omitempty"`
	Candidates []aiCandidate `json:"candidates,omitempty"`
	Sync       *SyncPlan     `json:"sync,omitempty"`
	Owned      bool          `json:"owned,omitempty"`
	InAutoSync bool          `json:"inAutoSync,omitempty"`
}

func aiCands(c []plexCandidate) []aiCandidate {
	out := make([]aiCandidate, 0, len(c))
	for _, x := range c {
		out = append(out, aiCandidate(x))
	}
	return out
}

// aiSuggestionBlob is the user's aggregated suggestions as the Suggestions
// page would show them: the cached blob, refreshed in the background when
// stale. Never built on the request - a build can take minutes (language
// probes, provider rate limits) and the chat stream would sit silent that
// long. building reports that a rebuild is running and the blob may be old
// or empty.
func (s *Server) aiSuggestionBlob(ctx context.Context, userID int64) (resp SuggestionsResponse, building bool) {
	key := fmt.Sprintf("suggestions:%d", userID)
	payload, fresh := s.cacheGet(key, suggestTTL)
	if !fresh {
		s.runJob(key, func(ctx context.Context) { s.buildUserSuggestions(ctx, userID) })
		payload, _ = s.cacheGet(key, 365*24*time.Hour) // whatever is there beats nothing
		building = true
	}
	json.Unmarshal([]byte(payload), &resp)
	return resp, building
}

func (s *Server) aiSuggestions(ctx context.Context, userID int64) any {
	blob, building := s.aiSuggestionBlob(ctx, userID)
	dismissed := s.dismissedKeys(userID, "suggestion")
	have := s.aiHaveIndex(userID)
	conv := func(items []SugItem, limit int) []aiSugEntry {
		out := []aiSugEntry{}
		for _, it := range items {
			if dismissed[it.RefKey] {
				continue
			}
			if len(out) >= limit {
				break
			}
			e := aiSugEntry{RefKey: it.RefKey, Title: it.Title, Year: it.Year, Category: it.Category, Status: it.Status,
				Progress: it.Progress, Have: it.Have, Need: it.Need, Because: it.Because, Genres: it.Media.Genres,
				Candidates: aiCands(it.Candidates),
				Owned:      it.PlexFolder != "" || have.owned(it.Media, "anilist"), InAutoSync: have.inSync(it.Media, "anilist")}
			if it.Sync.LocalPath != "" {
				sp := it.Sync
				e.Sync = &sp
			}
			out = append(out, e)
		}
		return out
	}
	out := map[string]any{
		"watchlist":   conv(blob.Watchlist, 60),
		"recommended": conv(blob.Recommended, 40),
		"trending":    conv(blob.Trending, 30),
		"incomplete":  conv(blob.Incomplete, 40),
	}
	if building {
		out["note"] = "suggestions are being rebuilt in the background; this list may be stale or empty, ask again in a few minutes for the fresh one"
	}
	return out
}

type aiVariant struct {
	ServerID   int64    `json:"serverId"`
	ServerName string   `json:"serverName,omitempty"`
	Folder     string   `json:"folder"`
	Resolution string   `json:"resolution"`
	Dub        []string `json:"dub"`
	Sub        []string `json:"sub"`
	Soft       []string `json:"soft"`
	Probed     string   `json:"languages"` // measured | from file names | unmeasurable
}

func aiVar(v UpgradeVariant) aiVariant {
	probed := "from file names"
	switch v.Probed {
	case 1:
		probed = "measured"
	case 2:
		probed = "unmeasurable"
	}
	return aiVariant{ServerID: v.ServerID, ServerName: v.ServerName, Folder: v.Folder, Resolution: fmtRes(v.ResRank),
		Dub: v.Dub, Sub: v.Sub, Soft: v.Soft, Probed: probed}
}

func fmtRes(r int) string {
	switch {
	case r <= 0:
		return "unknown"
	case r >= 2160:
		return "4K"
	}
	return fmt.Sprintf("%dp", r)
}

func (s *Server) aiUpgrades(ctx context.Context, userID int64) any {
	blob, building := s.aiSuggestionBlob(ctx, userID)
	dismissed := s.dismissedKeys(userID, "upgrade")
	dims := s.upgradeDimsFor(userID)
	out := []map[string]any{}
	for _, up := range blob.Upgrades {
		if dismissed[up.Key] || len(out) >= 40 {
			continue
		}
		opts := make([]aiVariant, 0, len(up.Options))
		for _, o := range up.Options {
			opts = append(opts, aiVar(o))
		}
		out = append(out, map[string]any{
			"key": up.Key, "title": up.Title, "season": up.Season, "isMovie": up.IsMovie,
			"local": aiVar(up.From), "recommended": aiVar(up.To), "options": opts,
			"improves":           map[string]bool{"res": up.ImprovesRes, "sub": up.ImprovesSub, "dub": up.ImprovesDub, "soft": up.ImprovesSoft},
			"languageUnverified": up.LanguageUnverified,
		})
	}
	res := map[string]any{"enabledAxes": dims, "upgrades": out}
	if building {
		res["note"] = "upgrades are being recomputed in the background; this list may be stale or empty"
	}
	return res
}

func (s *Server) aiSeasonal(ctx context.Context, userID int64, season string, year int) any {
	switch season {
	case "WINTER", "SPRING", "SUMMER", "FALL":
	default:
		return map[string]any{"error": "season must be WINTER, SPRING, SUMMER or FALL"}
	}
	if year < 1960 || year > time.Now().Year()+1 {
		return map[string]any{"error": "year out of range"}
	}
	list, err := s.Anilist.Season(ctx, season, year)
	if err != nil {
		return map[string]any{"error": "AniList unavailable: " + logSafe(err.Error())}
	}
	onList := map[int]anilist.ListEntry{}
	for _, e := range s.aiUserList(userID) {
		onList[e.Media.ID] = e
	}
	have := s.aiHaveIndex(userID)
	type entry struct {
		aiListEntry
		Episodes   int           `json:"episodes,omitempty"`
		Airing     string        `json:"airing,omitempty"`
		Score      int           `json:"averageScore,omitempty"`
		Candidates []aiCandidate `json:"candidates,omitempty"`
	}
	out := make([]entry, 0, len(list))
	for _, m := range list {
		e := entry{aiListEntry: aiListEntry{ID: m.ID, Title: aiTitle(m), Year: m.SeasonYear, Format: m.Format, Genres: m.Genres,
			Owned: have.owned(m, "anilist"), InAutoSync: have.inSync(m, "anilist")},
			Episodes: m.Episodes, Airing: m.Status, Score: m.AverageScore}
		if le, ok := onList[m.ID]; ok {
			e.Status, e.Progress, e.aiListEntry.Score = le.Status, le.Progress, le.Score
		}
		e.Candidates = aiCands(s.remoteCandidates(userID, m))
		out = append(out, e)
	}
	return map[string]any{"season": season, "year": year, "anime": out}
}

type aiFolder struct {
	ServerID   int64    `json:"serverId"`
	ServerName string   `json:"serverName"`
	Path       string   `json:"path"`
	Resolution string   `json:"resolution,omitempty"`
	Dub        []string `json:"dub,omitempty"`
	Sub        []string `json:"sub,omitempty"`
	Season     int      `json:"season,omitempty"`
	IsMovie    bool     `json:"isMovie,omitempty"`
	MatchedTo  string   `json:"matchedTo,omitempty"` // the title the catalog matched this folder to
}

// aiSearchRemote finds folders across the user's servers whose name holds
// every word of the query, with what the catalog knows about them.
func (s *Server) aiSearchRemote(userID int64, query string) any {
	words := strings.Fields(match.GuessTitle(query))
	if len(words) == 0 {
		words = strings.Fields(query)
	}
	if len(words) == 0 {
		return map[string]any{"error": "query required"}
	}
	if len(words) > 6 {
		words = words[:6]
	}
	q := `SELECT i.server_id, s.name, i.path,
		COALESCE(v.res_rank, 0), COALESCE(v.dub_codes, ''), COALESCE(v.sub_codes, ''), COALESCE(v.season, 0), COALESCE(v.is_movie, 0)
		FROM remote_index i JOIN servers s ON s.id = i.server_id AND s.user_id = ?
		LEFT JOIN catalog_variants v ON v.server_id = i.server_id AND v.folder = i.path
		WHERE i.is_dir = 1`
	args := []any{userID}
	for _, wd := range words {
		q += ` AND i.name LIKE '%' || ? || '%' ESCAPE '\' COLLATE NOCASE`
		args = append(args, escapeLike(wd))
	}
	q += ` ORDER BY i.name COLLATE NOCASE LIMIT 30`
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	defer rows.Close()
	out := []aiFolder{}
	for rows.Next() {
		var f aiFolder
		var res int
		var dub, sub string
		var isMovie int
		if rows.Scan(&f.ServerID, &f.ServerName, &f.Path, &res, &dub, &sub, &f.Season, &isMovie) != nil {
			continue
		}
		if res > 0 {
			f.Resolution = fmtRes(res)
		}
		f.Dub, f.Sub, f.IsMovie = splitCSV(dub), splitCSV(sub), isMovie == 1
		f.MatchedTo = s.aiMatchedTitle(f.ServerID, f.Path)
		out = append(out, f)
	}
	return map[string]any{"folders": out}
}

// aiMatchedTitle names the provider title the catalog matched a folder to,
// "" when unmatched.
func (s *Server) aiMatchedTitle(serverID int64, folder string) string {
	var source string
	var mediaID int
	if s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&source, &mediaID); source == "" || mediaID == 0 {
		return ""
	}
	if m, _ := s.sourceMedia(source, mediaID); m != nil {
		return aiTitle(*m)
	}
	return ""
}

func (s *Server) aiWatches(userID int64) any {
	rows, err := s.DB.Query(`SELECT w.id, s.name, w.remote_path, w.local_path, w.title_override
		FROM watches w JOIN servers s ON s.id = w.server_id WHERE w.user_id = ? ORDER BY w.id`, userID)
	if err != nil {
		return map[string]any{"error": "db error"}
	}
	defer rows.Close()
	type watch struct {
		ID         int64  `json:"id"`
		ServerName string `json:"serverName"`
		RemotePath string `json:"remotePath"`
		LocalPath  string `json:"localPath"`
		Title      string `json:"title,omitempty"`
	}
	out := []watch{}
	for rows.Next() {
		var w watch
		if rows.Scan(&w.ID, &w.ServerName, &w.RemotePath, &w.LocalPath, &w.Title) == nil {
			if w.Title == "" {
				w.Title = match.GuessTitle(path.Base(w.RemotePath))
			}
			out = append(out, w)
		}
	}
	return map[string]any{"watches": out}
}

// ── propose: the checks ──

// aiPropose vets a proposal against the catalog and returns it, or a reason
// the model has to relay. Nothing here writes.
func (s *Server) aiPropose(ctx context.Context, userID int64, kind string, serverID int64, remotePath, title, upgradeKey, refKey string) (*aiProposal, string) {
	remotePath = strings.TrimSpace(remotePath)
	title = strings.TrimSpace(title)
	if kind != "watch" && kind != "sync" && kind != "upgrade" {
		return nil, "kind must be watch, sync or upgrade"
	}
	if serverID == 0 || remotePath == "" {
		return nil, "serverId and remotePath required"
	}
	var serverName string
	if s.DB.QueryRow(`SELECT name FROM servers WHERE id = ? AND user_id = ?`, serverID, userID).Scan(&serverName); serverName == "" {
		return nil, "server not found"
	}
	var isDir int
	if err := s.DB.QueryRow(`SELECT is_dir FROM remote_index WHERE server_id = ? AND path = ?`, serverID, remotePath).Scan(&isDir); err != nil || isDir != 1 {
		return nil, "that folder does not exist in the index of " + serverName + "; use search_remote and pick an existing path"
	}
	if title == "" {
		title = match.GuessTitle(path.Base(remotePath))
	}
	p := &aiProposal{Kind: kind, Title: title, ServerID: serverID, ServerName: serverName, RemotePath: remotePath}
	p.Fields = aiWatchFields{RemotePath: remotePath, LocalPath: s.DownloadRoot, Mode: "template", TitleOverride: title,
		Subfolder: true, MediaSource: "anilist"}

	switch kind {
	case "upgrade":
		if upgradeKey == "" {
			return nil, "an upgrade needs the key from the upgrades tool"
		}
		blob, _ := s.aiSuggestionBlob(ctx, userID)
		var up *UpgradeSuggestion
		for i := range blob.Upgrades {
			if blob.Upgrades[i].Key == upgradeKey {
				up = &blob.Upgrades[i]
				break
			}
		}
		if up == nil {
			return nil, "unknown upgrade key; take one from the upgrades tool"
		}
		var opt *UpgradeVariant
		for i := range up.Options {
			if up.Options[i].ServerID == serverID && up.Options[i].Folder == remotePath {
				opt = &up.Options[i]
				break
			}
		}
		if opt == nil {
			return nil, "that folder is not one of the upgrade's option folders"
		}
		info, unverified, ok := s.aiUpgradeGain(userID, up, *opt)
		if !ok {
			return nil, "that copy improves none of the axes the user enabled (" + strings.Join(info, "; ") + ")"
		}
		p.Title, p.Info, p.Unverified = up.Title, info, unverified
		p.Fields.LocalPath, p.Fields.Template, p.Fields.Subfolder = up.Sync.LocalPath, up.Sync.Template, up.Sync.Subfolder
		p.Fields.TitleOverride = up.Title
		return p, ""
	case "sync":
		if refKey != "" {
			blob, _ := s.aiSuggestionBlob(ctx, userID)
			for _, it := range blob.Incomplete {
				if it.RefKey != refKey {
					continue
				}
				found := false
				for _, c := range it.Candidates {
					if c.ServerID == serverID && c.Path == remotePath {
						found = true
					}
				}
				if !found {
					return nil, "that folder is not a candidate of " + it.Title
				}
				p.Title = it.Title
				p.Fields.TitleOverride = it.Title
				if it.Sync.LocalPath != "" {
					p.Fields.LocalPath, p.Fields.Template, p.Fields.Subfolder = it.Sync.LocalPath, it.Sync.Template, it.Sync.Subfolder
				}
				if it.Need > 0 {
					p.Info = append(p.Info, fmt.Sprintf("%d of %d episodes present locally", it.Have, it.Need))
				}
				return p, ""
			}
		}
	case "watch":
		var n int
		s.DB.QueryRow(`SELECT COUNT(*) FROM watches WHERE user_id = ? AND server_id = ? AND remote_path = ?`, userID, serverID, remotePath).Scan(&n)
		if n > 0 {
			return nil, "an auto-sync for that folder already exists"
		}
	}
	// a free folder: when the catalog has matched it, the match must agree
	// with the title the model claims it is
	if matched := s.aiMatchedTitle(serverID, remotePath); matched != "" && !titlesAgree(matched, title) {
		return nil, "that folder is matched to \"" + matched + "\", not to \"" + title + "\""
	}
	return p, ""
}

// aiUpgradeGain lists what a remote copy improves over the local one on the
// axes the user enabled; ok is false when nothing does. Mirrors the card.
func (s *Server) aiUpgradeGain(userID int64, up *UpgradeSuggestion, to UpgradeVariant) (info []string, unverified bool, ok bool) {
	dims := s.upgradeDimsFor(userID)
	from := up.From
	if dims.Res && resTier(to.ResRank) > resTier(from.ResRank) {
		info = append(info, fmtRes(from.ResRank)+" → "+fmtRes(to.ResRank))
		ok = true
	}
	if add := missing(from.Dub, to.Dub); dims.Dub && len(add) > 0 {
		info = append(info, "dub: +"+strings.Join(add, ", "))
		ok = true
	}
	if add := missing(from.Sub, to.Sub); dims.Sub && len(add) > 0 {
		info = append(info, "sub: +"+strings.Join(add, ", "))
		ok = true
	}
	if add := missing(from.Soft, to.Soft); dims.Soft && len(add) > 0 {
		info = append(info, "selectable subtitles: +"+strings.Join(add, ", "))
		ok = true
	}
	if !ok {
		info = []string{"local " + fmtRes(from.ResRank) + " dub " + strings.Join(from.Dub, ",") + " sub " + strings.Join(from.Sub, ","),
			"remote " + fmtRes(to.ResRank) + " dub " + strings.Join(to.Dub, ",") + " sub " + strings.Join(to.Sub, ",")}
	}
	unverified = up.LanguageUnverified || to.Probed != 1 || from.Probed != 1
	if unverified {
		info = append(info, "language data not measured from the files")
	}
	return info, unverified, ok
}

// missing returns the entries of want that have is lacking.
func missing(have, want []string) []string {
	set := map[string]bool{}
	for _, h := range have {
		set[strings.ToLower(h)] = true
	}
	var out []string
	for _, w := range want {
		if !set[strings.ToLower(w)] {
			out = append(out, w)
		}
	}
	return out
}

// titlesAgree is a lenient same-title test: fold keys equal, or one folded
// title contains the other (a season suffix or a subtitle on one side).
func titlesAgree(a, b string) bool {
	fa, fb := match.FoldKey(match.StripMarkers(a)), match.FoldKey(match.StripMarkers(b))
	if fa == "" || fb == "" {
		return true
	}
	return fa == fb || strings.Contains(fa, fb) || strings.Contains(fb, fa)
}
