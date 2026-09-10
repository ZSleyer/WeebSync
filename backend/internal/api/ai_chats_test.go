package api

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
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

// A picture on the user's message reaches the provider as an image part
// next to the text, re-encoded as a plain JPEG; a picture that is not a
// decodable data:image URL is dropped.
func TestAiChatImagesBecomeContentParts(t *testing.T) {
	fp := newFakeProvider(t, fakeReply{text: "A cat."})
	mux, _, c := setupAiTest(t, fp)
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	pic := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	body := `{"messages":[{"role":"user","content":"what is this?","images":["` + pic + `","data:image/png;base64,iVBORw0KGgo=","https://example.com/x.png"]}]}`
	if rec := doReq(mux, "POST", "/api/ai/chat", body, c); rec.Code != 200 {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body)
	}
	raw := string(fp.raw)
	if strings.Count(raw, `"type":"image_url"`) != 1 || !strings.Contains(raw, `data:image/jpeg;base64,`) || !strings.Contains(raw, `"type":"text","text":"what is this?"`) {
		t.Errorf("parts missing: %s", raw)
	}
	if strings.Contains(raw, "example.com") {
		t.Errorf("non-data url forwarded: %s", raw)
	}
}
