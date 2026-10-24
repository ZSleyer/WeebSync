package api

import (
	"net/http"
	"strings"
	"testing"
)

// The list shows chats by their last change; the trims must keep the same
// ones. An old chat (lowest id) the user just continued is the newest, and
// creating another chat at the limit must not delete it.
func TestAiChatCountTrimKeepsRecentlyUsed(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	for i := 0; i < maxAIChats; i++ {
		if _, err := s.DB.Exec(`INSERT INTO ai_chats (user_id, title, updated_at) VALUES (1, 'old', '2020-01-01 00:00:00')`); err != nil {
			t.Fatal(err)
		}
	}
	// the oldest chat is opened and continued
	if rec := doReq(mux, "PUT", "/api/ai/chats/1", `{"title":"continued","turns":[]}`, c); rec.Code != http.StatusOK {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/ai/chats", `{"title":"new","turns":[]}`, c); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/ai/chats/1", "", c); rec.Code != http.StatusOK {
		t.Fatalf("the chat just continued was trimmed: %d", rec.Code)
	}
}

func TestAiChatByteTrimKeepsRecentlyUsed(t *testing.T) {
	_, s, _ := setupAiTest(t, nil)
	old := maxAIChatBytes
	maxAIChatBytes = 250
	defer func() { maxAIChatBytes = old }()
	turns := `["` + strings.Repeat("x", 96) + `"]` // 100 bytes
	for _, at := range []string{"2026-10-24 12:00:00", "2020-01-02 00:00:00", "2020-01-01 00:00:00"} {
		if _, err := s.DB.Exec(`INSERT INTO ai_chats (user_id, turns, updated_at) VALUES (1, ?, ?)`, turns, at); err != nil {
			t.Fatal(err)
		}
	}
	s.trimAIChats(1)
	var ids []int
	rows, err := s.DB.Query(`SELECT id FROM ai_chats ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != 1 || ids[1] != 2 {
		t.Fatalf("kept chats %v, want [1 2] (the two last changed)", ids)
	}
}
