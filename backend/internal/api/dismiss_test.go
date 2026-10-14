package api

import (
	"encoding/json"
	"testing"
)

func TestDismissKeepsCoverAndSection(t *testing.T) {
	mux, _, c := setupAiTest(t, nil)
	for _, body := range []string{
		`{"kind":"suggestion","refKey":"series:1","label":"Frieren","cover":"https://img.example.com/f.jpg","section":"watchlist"}`,
		// a picture that is no web address and a section that is no id are dropped, the item still hides
		`{"kind":"upgrade","refKey":"up:2","label":"Dandadan","cover":"javascript:alert(1)","section":"Up grades!"}`,
		// an old client sends neither
		`{"kind":"duplicate","refKey":"dup:3","label":"Mushishi"}`,
	} {
		if rec := doReq(mux, "POST", "/api/suggestions/dismiss", body, c); rec.Code != 200 {
			t.Fatalf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
	rec := doReq(mux, "GET", "/api/suggestions/dismissed", "", c)
	var list []DismissedItem
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	got := map[string]DismissedItem{}
	for _, d := range list {
		got[d.RefKey] = d
	}
	if d := got["series:1"]; d.Cover != "https://img.example.com/f.jpg" || d.Section != "watchlist" {
		t.Errorf("kept item: %+v", d)
	}
	if d := got["up:2"]; d.Cover != "" || d.Section != "" || d.Label != "Dandadan" {
		t.Errorf("filtered item: %+v", d)
	}
	if d, ok := got["dup:3"]; !ok || d.Cover != "" || d.Section != "" {
		t.Errorf("bare item: %+v", d)
	}
}
