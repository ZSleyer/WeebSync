package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
)

// Saved assistant conversations. The turns are the client's own record of a
// chat - bubbles, cards, proposals, pictures - stored as the JSON it sends,
// so the history reopens exactly as it was left. The server only checks that
// it is a JSON array and that it belongs to the caller.

// aiChatSummary is one row of the history list.
type aiChatSummary struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

// aiChatBody is what the client saves: a title and the turns as it renders
// them, opaque objects the server stores as they came.
type aiChatBody struct {
	Title string           `json:"title"`
	Turns []map[string]any `json:"turns"`
}

// aiChatFull is a saved chat with its turns.
type aiChatFull struct {
	aiChatSummary
	Turns []map[string]any `json:"turns"`
}

// aiChatCreated names the row a new chat got.
type aiChatCreated struct {
	ID int64 `json:"id"`
}

const aiChatTitleMax = 120

func (b *aiChatBody) valid(w http.ResponseWriter) bool {
	if b.Turns == nil {
		writeErr(w, http.StatusBadRequest, "turns must be a json array")
		return false
	}
	b.Title = strings.TrimSpace(b.Title)
	if len(b.Title) > aiChatTitleMax {
		b.Title = b.Title[:aiChatTitleMax]
	}
	return true
}

// handleAiChatsList lists the caller's saved chats, newest change first.
//
//	@Summary		List saved assistant chats
//	@Tags			Assistant
//	@Produce		json
//	@Success		200	{array}	aiChatSummary
//	@Security		CookieAuth
//	@Router			/api/ai/chats [get]
func (s *Server) handleAiChatsList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, title, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 200`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	out := []aiChatSummary{}
	for rows.Next() {
		var c aiChatSummary
		if rows.Scan(&c.ID, &c.Title, &c.UpdatedAt) == nil {
			out = append(out, c)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAiChatCreate saves a new chat.
//
//	@Summary		Save a new assistant chat
//	@Tags			Assistant
//	@Accept			json
//	@Produce		json
//	@Param			body	body		aiChatBody	true	"title and turns"
//	@Success		200		{object}	aiChatCreated
//	@Failure		400		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/ai/chats [post]
func (s *Server) handleAiChatCreate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in aiChatBody
	if !readJSONLimit(w, r, &in, aiChatBodyLimit) || !in.valid(w) {
		return
	}
	turns, _ := json.Marshal(in.Turns)
	res, err := s.DB.Exec(`INSERT INTO ai_chats (user_id, title, turns) VALUES (?, ?, ?)`, u.ID, in.Title, string(turns))
	if err != nil {
		dbErr(w)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusOK, aiChatCreated{ID: id})
}

// handleAiChatGet returns one saved chat with its turns.
//
//	@Summary		Get a saved assistant chat
//	@Tags			Assistant
//	@Produce		json
//	@Param			id	path		int	true	"chat id"
//	@Success		200	{object}	aiChatFull
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/ai/chats/{id} [get]
func (s *Server) handleAiChatGet(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var c aiChatFull
	var turns string
	err := s.DB.QueryRow(`SELECT id, title, updated_at, turns FROM ai_chats WHERE id = ? AND user_id = ?`, pathID(r), u.ID).
		Scan(&c.ID, &c.Title, &c.UpdatedAt, &turns)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusNotFound, "chat not found")
		return
	}
	if err != nil {
		dbErr(w)
		return
	}
	if json.Unmarshal([]byte(turns), &c.Turns) != nil || c.Turns == nil {
		c.Turns = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, c)
}

// handleAiChatPut replaces a saved chat's title and turns.
//
//	@Summary		Update a saved assistant chat
//	@Tags			Assistant
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int			true	"chat id"
//	@Param			body	body		aiChatBody	true	"title and turns"
//	@Success		200		{object}	OkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure			404		{object}	ErrorResponse
//	@Failure		415		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/ai/chats/{id} [put]
func (s *Server) handleAiChatPut(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in aiChatBody
	if !readJSONLimit(w, r, &in, aiChatBodyLimit) || !in.valid(w) {
		return
	}
	turns, _ := json.Marshal(in.Turns)
	res, err := s.DB.Exec(`UPDATE ai_chats SET title = ?, turns = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
		in.Title, string(turns), pathID(r), u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "chat not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// handleAiChatDelete removes a saved chat.
//
//	@Summary		Delete a saved assistant chat
//	@Tags			Assistant
//	@Produce		json
//	@Param			id	path		int	true	"chat id"
//	@Success		200	{object}	OkResponse
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/ai/chats/{id} [delete]
func (s *Server) handleAiChatDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	res, err := s.DB.Exec(`DELETE FROM ai_chats WHERE id = ? AND user_id = ?`, pathID(r), u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "chat not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
