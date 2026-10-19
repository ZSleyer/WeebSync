package api

import (
	"encoding/json"
	"testing"
	"time"
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

// The list holds the detected marks only, newest first; once seen they stop
// counting as new, a later detection counts again, and a mark the user changed
// leaves the list.
func TestDetectedMarksList(t *testing.T) {
	s, call := scopeServer(t)
	list := func() (out detectedMarksResponse) {
		w := call("GET", "/api/catalog/detected-marks", "")
		if w.Code != 200 {
			t.Fatalf("list: %d %s", w.Code, w.Body)
		}
		json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/Server/By Hand', 'anime')`)
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind, detected_at) VALUES
		(1, '/Server/Older', 'auto', 1000), (1, '/Server/Newer', 'anime', 2000)`)
	got := list()
	if got.Unseen != 2 || len(got.Items) != 2 || got.Items[0].Path != "/Server/Newer" || got.Items[0].Name != "Newer" ||
		got.Items[1].Kind != "auto" || !got.Items[0].Unseen || got.Items[0].ServerName != "seedbox" {
		t.Fatalf("list = %+v", got)
	}
	if w := call("POST", "/api/catalog/detected-marks/seen", ""); w.Code != 200 {
		t.Fatalf("seen: %d %s", w.Code, w.Body)
	}
	if got := list(); got.Unseen != 0 || len(got.Items) != 2 || got.Items[0].Unseen {
		t.Fatalf("after seen = %+v", got)
	}
	// marked later than the user looked
	detect(t, s, "/Server/Later", "auto")
	s.DB.Exec(`UPDATE catalog_scopes SET detected_at = ? WHERE path = '/Server/Later'`, time.Now().Add(time.Minute).UnixMilli())
	if got := list(); got.Unseen != 1 || !got.Items[0].Unseen || got.Items[0].Path != "/Server/Later" {
		t.Fatalf("after a new one = %+v", got)
	}
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Later","kind":"none"}`)
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Older","kind":"manga"}`)
	if got := list(); got.Unseen != 0 || len(got.Items) != 1 || got.Items[0].Path != "/Server/Newer" {
		t.Fatalf("after the user's changes = %+v", got)
	}
}
