package api

import (
	"encoding/json"
	"testing"
)

// detect writes a mark the way the detection does.
func detect(t *testing.T, s *Server, p, kind string) {
	t.Helper()
	if _, err := s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind, detected_at) VALUES (1, ?, ?, 1000)`, p, kind); err != nil {
		t.Fatal(err)
	}
}

func scopeRow(t *testing.T, s *Server, p string) (kind string, at int64, ok bool) {
	t.Helper()
	err := s.DB.QueryRow(`SELECT kind, detected_at FROM catalog_scopes WHERE server_id = 1 AND path = ?`, p).Scan(&kind, &at)
	return kind, at, err == nil
}

// A user's change of kind, "none" or removal replaces the detected row with
// the user's own; a removal keeps a "none" so the folder is not detected again.
func TestUserDecisionReplacesDetectedMark(t *testing.T) {
	s, call := scopeServer(t)
	for _, c := range []struct{ kind, want string }{{"anime", "anime"}, {"none", "none"}, {"", "none"}} {
		detect(t, s, "/Server/Some Category", "auto")
		var info scopeResponse
		json.Unmarshal(call("GET", "/api/servers/1/catalog/scope?path=/Server/Some%20Category", "").Body.Bytes(), &info)
		if !info.Detected || info.Scope != "auto" {
			t.Fatalf("detected mark = %+v", info)
		}
		if w := call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"`+c.kind+`"}`); w.Code != 200 {
			t.Fatalf("put %q: %d %s", c.kind, w.Code, w.Body)
		}
		kind, at, ok := scopeRow(t, s, "/Server/Some Category")
		if !ok || kind != c.want || at != 0 {
			t.Errorf("after %q: row %q at %d (%v), want %q at 0", c.kind, kind, at, ok, c.want)
		}
		s.DB.Exec(`DELETE FROM catalog_scopes`)
	}
	// clearing a user's plain mark still deletes the row
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"anime"}`)
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":""}`)
	if _, _, ok := scopeRow(t, s, "/Server/Some Category"); ok {
		t.Error("a user's cleared mark left a row")
	}
}
