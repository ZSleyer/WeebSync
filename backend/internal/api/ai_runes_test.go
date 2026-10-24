package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

// Japanese titles take three bytes a character: a cut by bytes at the limit
// lands inside one and leaves invalid UTF-8 (a "�" on the card, in the
// transcript, in the chat list).
func TestExcerptCutsWholeCharacters(t *testing.T) {
	got := excerpt("x"+strings.Repeat("葬送のフリーレン", 30), 120)
	if !utf8.ValidString(got) {
		t.Fatalf("excerpt split a character: %q", got)
	}
	if n := utf8.RuneCountInString(strings.TrimSuffix(got, "…")); n != 120 {
		t.Errorf("excerpt kept %d characters, want 120", n)
	}
	if got := excerpt("短い", 120); got != "短い" {
		t.Errorf("short text changed: %q", got)
	}
}

func TestAiChatTitleCutsWholeCharacters(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	title := "x" + strings.Repeat("葬", 200)
	if rec := doReq(mux, "POST", "/api/ai/chats", `{"title":"`+title+`","turns":[]}`, c); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var stored string
	if err := s.DB.QueryRow(`SELECT title FROM ai_chats`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(stored) {
		t.Fatalf("stored title is not valid UTF-8: %q", stored)
	}
	if n := utf8.RuneCountInString(stored); n != aiChatTitleMax {
		t.Errorf("stored title has %d characters, want %d", n, aiChatTitleMax)
	}
}

func TestAiFetchPageCutsWholeCharacters(t *testing.T) {
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("x" + strings.Repeat("あ", aiPageChars)))
	}))
	t.Cleanup(web.Close)
	prev := aiPageHTTP
	aiPageHTTP = web.Client()
	t.Cleanup(func() { aiPageHTTP = prev })
	s := testServer(t, &Server{})

	sc := newAiWebScope()
	sc.add(web.URL + "/p")
	out, _ := s.aiFetchPage(context.Background(), sc, web.URL+"/p").(map[string]any)
	text, _ := out["text"].(string)
	if !utf8.ValidString(text) {
		t.Fatalf("page text split a character")
	}
	if n := utf8.RuneCountInString(text); n != aiPageChars || out["truncated"] != true || out["chars"] != aiPageChars {
		t.Errorf("kept %d characters (chars=%v, truncated=%v), want %d", n, out["chars"], out["truncated"], aiPageChars)
	}
}
