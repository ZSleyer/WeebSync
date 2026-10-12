package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFolderShape(t *testing.T) {
	same := [][2]string{
		{"2026-3 Summer", "2026-4 Fall"},
		{"2026-4 Fall", "2027-1 Winter"},
		{"Fall 2026", "Herbst 2027"},
		{"Serien-1080P", "Serien-720P"},
		{"2026 Q4", "2027 Q1"},
	}
	for _, p := range same {
		if folderShape(p[0]) != folderShape(p[1]) {
			t.Errorf("%q and %q should share a shape: %q vs %q", p[0], p[1], folderShape(p[0]), folderShape(p[1]))
		}
	}
	differ := [][2]string{
		{"2026-3 Summer", "Anderes"},
		{"2026-3 Summer", "BD [Fansub & Remux]"},
		{"Serien-1080P", "Anime-1080P"},
		{"WEB", "Anderes"},
	}
	for _, p := range differ {
		if folderShape(p[0]) == folderShape(p[1]) {
			t.Errorf("%q and %q must not share a shape (%q)", p[0], p[1], folderShape(p[0]))
		}
	}
	if got := folderShape("2026-3 Summer"); got != "{n}-{n} {season}" {
		t.Errorf("shape = %q", got)
	}
	for name, varies := range map[string]bool{"2026-3 Summer": true, "Serien-1080P": true, "Anderes": false, "WEB": false} {
		if shapeVaries(folderShape(name)) != varies {
			t.Errorf("shapeVaries(%q) = %v", name, !varies)
		}
	}
}

// scopeServer is a router with a signed-in owner of server 1.
func scopeServer(t *testing.T) (*Server, func(method, url, body string) *httptest.ResponseRecorder) {
	s, _ := sizeTestServer(t)
	mux := http.NewServeMux()
	s.Register(mux)
	tok := "scope-rules-test-session"
	sum := sha256.Sum256([]byte(tok))
	s.DB.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)`,
		hex.EncodeToString(sum[:]), time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	return s, func(method, url, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "weebsync_session", Value: tok})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
}

// A rule made from "2026-3 Summer" marks the next season folder, and nothing
// else beside it; a folder's own mark and a stored "none" both beat it.
func TestScopeRules(t *testing.T) {
	s, call := scopeServer(t)
	const root = "/Server"
	if w := call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/2026-3 Summer","kind":"anime","rule":true}`); w.Code != 200 {
		t.Fatalf("mark with rule: %d %s", w.Code, w.Body.String())
	}
	for p, want := range map[string]string{
		root + "/2026-3 Summer": "anime",
		root + "/2026-4 Fall":   "anime",
		root + "/Anderes":       "",
		"/Other/2026-4 Fall":    "", // another parent
	} {
		if got := s.scopeFor(1, p); got != want {
			t.Errorf("scopeFor(%q) = %q, want %q", p, got, want)
		}
	}

	var out scopeResponse
	w := call("GET", "/api/servers/1/catalog/scope?path="+strings.ReplaceAll(root+"/2026-4 Fall", " ", "%20"), "")
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.Scope != "anime" || out.RuleID == 0 || out.RuleKind != "anime" || out.RuleShape != "{n}-{n} {season}" {
		t.Errorf("scope of a ruled folder: %+v", out)
	}

	// clearing a ruled folder keeps the rule off it
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/2026-4 Fall","kind":""}`)
	if got := s.scopeFor(1, root+"/2026-4 Fall"); got != "" {
		t.Errorf("cleared ruled folder still %q", got)
	}
	// its own mark wins over the rule
	if w := call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/2026-4 Fall","kind":"manga"}`); w.Code != 200 {
		t.Fatalf("own mark: %d %s", w.Code, w.Body.String())
	}
	if got := s.scopeFor(1, root+"/2026-4 Fall"); got != "manga" {
		t.Errorf("own mark lost to the rule: %q", got)
	}

	if w := call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Anderes","kind":"anime","rule":true}`); w.Code != http.StatusBadRequest {
		t.Errorf("rule from a name that never varies: %d", w.Code)
	}

	var rules []scopeRule
	json.Unmarshal(call("GET", "/api/catalog/scope-rules", "").Body.Bytes(), &rules)
	if len(rules) != 1 || rules[0].Parent != root || rules[0].ServerName != "seedbox" {
		t.Fatalf("rules: %+v", rules)
	}
	if w := call("DELETE", "/api/catalog/scope-rules/"+strconv.FormatInt(rules[0].ID, 10), ""); w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	if got := s.scopeFor(1, root+"/2027-1 Winter"); got != "" {
		t.Errorf("deleted rule still marks: %q", got)
	}
}

// The sweep finds the folders a rule covers in the remote index: they hold no
// stored mark, and their titles would never be matched otherwise.
func TestRuleMarks(t *testing.T) {
	s, _ := sizeTestServer(t)
	for _, f := range []string{"/Server/2026-3 Summer", "/Server/2026-4 Fall", "/Server/Anderes", "/Server/2026-2 Spring"} {
		addRemoteFiles(t, s, 1, f, nil)
	}
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES (1, '/Server/2026-2 Spring', 'none')`)
	s.DB.Exec(`INSERT INTO catalog_scope_rules (server_id, parent, shape, kind) VALUES (1, '/Server', '{n}-{n} {season}', 'anime')`)
	got := map[string]string{}
	for _, m := range s.ruleMarks(1) {
		got[m[0]] = m[1]
	}
	want := map[string]string{"/Server/2026-3 Summer": "anime", "/Server/2026-4 Fall": "anime"}
	if len(got) != len(want) || got["/Server/2026-3 Summer"] != "anime" || got["/Server/2026-4 Fall"] != "anime" {
		t.Errorf("rule marks = %v, want %v", got, want)
	}
}
