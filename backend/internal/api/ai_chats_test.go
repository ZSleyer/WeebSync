package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestAiChatsRoundTripAndOwnership(t *testing.T) {
	mux, s, c := setupAiTest(t, nil)
	s.DB.Exec(`INSERT INTO users (email, is_admin) VALUES ('b@example.com', 0)`)
	other := cookieForUser(t, s.DB, 2)

	if rec := doReq(mux, "POST", "/api/ai/chats", `{"title":"x","turns":{"not":"a list"}}`, c); rec.Code != http.StatusBadRequest {
		t.Fatalf("object turns accepted: %d %s", rec.Code, rec.Body)
	}
	rec := doReq(mux, "POST", "/api/ai/chats", `{"title":"  Frieren season?  ","turns":[{"role":"user","content":"Frieren season?"}]}`, c)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":1`) {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/ai/chats", "", c)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"title":"Frieren season?"`) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "PUT", "/api/ai/chats/1", `{"title":"Frieren season?","turns":[{"role":"user","content":"Frieren season?"},{"role":"assistant","content":"Yes."}]}`, c)
	if rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/ai/chats/1", "", c)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"content":"Yes."`) {
		t.Fatalf("get: %d %s", rec.Code, rec.Body)
	}
	// another user sees, edits and deletes nothing of it
	if rec := doReq(mux, "GET", "/api/ai/chats/1", "", other); rec.Code != http.StatusNotFound {
		t.Errorf("other get: %d", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/ai/chats/1", `{"title":"pwned","turns":[]}`, other); rec.Code != http.StatusNotFound {
		t.Errorf("other put: %d", rec.Code)
	}
	if rec := doReq(mux, "DELETE", "/api/ai/chats/1", "", other); rec.Code != http.StatusNotFound {
		t.Errorf("other delete: %d", rec.Code)
	}
	if rec := doReq(mux, "GET", "/api/ai/chats", "", other); strings.Contains(rec.Body.String(), "Frieren") {
		t.Errorf("other list: %s", rec.Body)
	}
	if rec := doReq(mux, "DELETE", "/api/ai/chats/1", "", c); rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "GET", "/api/ai/chats/1", "", c); rec.Code != http.StatusNotFound {
		t.Errorf("after delete: %d", rec.Code)
	}
}
