package api

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

// markedPaths are the server's paths with a mark of any kind, with the kind
// and whether WeebSync set it.
func markedPaths(t *testing.T, s *Server) map[string]string {
	t.Helper()
	rows, err := s.DB.Query(`SELECT path, kind, detected_at FROM catalog_scopes WHERE server_id = 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var p, k string
		var at int64
		if err := rows.Scan(&p, &k, &at); err != nil {
			t.Fatal(err)
		}
		if at > 0 {
			k += "*"
		}
		out[p] = k
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func detectOnce(t *testing.T, s *Server) (marked, queued int) {
	t.Helper()
	s.collCache.by = nil // the scan is cached for minutes
	return s.detectMarks(t.Context(), 1)
}

// A folder of single titles is marked "auto" by the sweep and its subfolders
// are queued; a category root, a folder of containers, a music folder, a
// folder of seasons and one of non-videos are left alone.
func TestDetectMarksCollection(t *testing.T) {
	s, _ := scopeServer(t)
	collectionTree(t, s, "/Server/Some Category", publicTitles...)
	for _, c := range []string{"Box One", "Box Two", "Box Three", "Box Four", "Box Five"} {
		collectionTree(t, s, "/Server/Some Root/"+c, "Alpha Show", "Beta Show", "Gamma Show", "Delta Show")
	}
	collectionTree(t, s, "/Server/Music Videos", publicTitles...)
	for i := 1; i <= 6; i++ {
		addRemoteFiles(t, s, 1, fmt.Sprintf("/Server/Some Show/Season %d", i), map[string]int64{"Some Show - 01.mkv": 1})
	}
	for _, n := range publicTitles {
		addRemoteFiles(t, s, 1, "/Server/Some Documents Dump/"+n, map[string]int64{"notes.txt": 1})
	}
	collectionTree(t, s, "/Server/Small Category", publicTitles[:4]...)
	// the parts of one title, each in a folder of its own
	for i := 1; i <= 6; i++ {
		addRemoteFiles(t, s, 1, fmt.Sprintf("/Server/Some Parts/Some Show OVA %02d", i), map[string]int64{"x.mkv": 1})
	}

	marked, queued := detectOnce(t, s)
	got := markedPaths(t, s)
	if marked != 1 || queued != len(publicTitles) || len(got) != 1 || got["/Server/Some Category"] != "auto*" {
		t.Fatalf("marked %d, queued %d, marks %v", marked, queued, got)
	}
	// the second run finds nothing new
	if marked, _ := detectOnce(t, s); marked != 0 {
		t.Errorf("second run marked %d", marked)
	}
	if got := s.scopeFor(1, "/Server/Some Category"); got != "auto" {
		t.Errorf("scope = %q", got)
	}
}

// Japanese tags on the titles do not change the mark: it stays "auto".
func TestDetectMarksTaggedCollection(t *testing.T) {
	s, _ := scopeServer(t)
	var tagged []string
	for _, n := range publicTitles {
		tagged = append(tagged, n+" [JapDub,GerSub,CR]")
	}
	collectionTree(t, s, "/Server/Some Category", tagged...)
	detectOnce(t, s)
	if got := markedPaths(t, s); got["/Server/Some Category"] != "auto*" {
		t.Fatalf("marks %v", got)
	}
}

// A new season folder beside marked ones gets the siblings' kind; a folder of
// another shape and one the user marked as another kind are left as they are.
func TestDetectMarksSibling(t *testing.T) {
	s, _ := scopeServer(t)
	for _, f := range []string{"/Server/2026-2 Spring", "/Server/2026-3 Summer", "/Server/2026-4 Fall",
		"/Server/2027-1 Winter", "/Server/Anderes", "/Server/WEB", "/Server/Music 2027"} {
		addRemoteFiles(t, s, 1, f, nil)
	}
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES
		(1, '/Server/2026-2 Spring', 'anime'), (1, '/Server/2026-3 Summer', 'anime'), (1, '/Server/WEB', 'anime'),
		(1, '/Server/Music 2026', 'anime'), (1, '/Server/2027-1 Winter', 'none')`)
	marked, _ := detectOnce(t, s)
	got := markedPaths(t, s)
	if marked != 1 || got["/Server/2026-4 Fall"] != "anime*" || got["/Server/2027-1 Winter"] != "none" ||
		got["/Server/2026-2 Spring"] != "anime" || got["/Server/Anderes"] != "" || got["/Server/Music 2027"] != "" {
		t.Fatalf("marked %d, marks %v", marked, got)
	}
}

// What the user decided is never written over: a changed kind, "none" and a
// removed mark all stay, through any number of runs.
func TestDetectMarksUserDecisionWins(t *testing.T) {
	s, call := scopeServer(t)
	collectionTree(t, s, "/Server/Some Category", publicTitles...)
	for _, c := range []struct{ kind, want string }{{"anime", "anime"}, {"none", "none"}, {"", "none"}} {
		s.DB.Exec(`DELETE FROM catalog_scopes`)
		detectOnce(t, s)
		if got := markedPaths(t, s); got["/Server/Some Category"] != "auto*" {
			t.Fatalf("not detected: %v", got)
		}
		call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"`+c.kind+`"}`)
		for range 3 {
			detectOnce(t, s)
		}
		if got := markedPaths(t, s); len(got) != 1 || got["/Server/Some Category"] != c.want {
			t.Errorf("after %q: %v, want %q", c.kind, got, c.want)
		}
	}
	// a user's mark on an ordinary folder stays too
	s.DB.Exec(`DELETE FROM catalog_scopes`)
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"auto"}`)
	detectOnce(t, s)
	if got := markedPaths(t, s); got["/Server/Some Category"] != "auto" {
		t.Errorf("a user's auto mark was taken over: %v", got)
	}
}

// Nothing is marked inside a marked folder or above one.
func TestDetectMarksNotInsideOrAboveAMark(t *testing.T) {
	s, _ := scopeServer(t)
	collectionTree(t, s, "/Server/Inside/Some Category", publicTitles...)
	collectionTree(t, s, "/Server/Above", publicTitles...)
	collectionTree(t, s, "/Server/Free", publicTitles...)
	s.DB.Exec(`INSERT INTO catalog_scopes (server_id, path, kind) VALUES
		(1, '/Server/Inside', 'anime'), (1, '/Server/Above/Cowboy Bebop', 'tv')`)
	detectOnce(t, s)
	got := markedPaths(t, s)
	if len(got) != 3 || got["/Server/Free"] != "auto*" {
		t.Fatalf("marks %v", got)
	}
}

// A run sets at most autoMarkBatch marks per server and queues the children of
// each; the rest follow in the next run.
func TestDetectMarksBatch(t *testing.T) {
	s, _ := scopeServer(t)
	n := autoMarkBatch + 2
	for i := range n {
		collectionTree(t, s, fmt.Sprintf("/Server/Category %c", 'A'+i), publicTitles...)
	}
	marked, queued := detectOnce(t, s)
	if marked != autoMarkBatch || queued != autoMarkBatch*len(publicTitles) {
		t.Fatalf("marked %d queued %d", marked, queued)
	}
	if marked, _ := detectOnce(t, s); marked != 2 {
		t.Errorf("second run marked %d", marked)
	}
	if got := markedPaths(t, s); len(got) != n {
		t.Errorf("marks %v", got)
	}
}

// With every provider off for matching a mark would do nothing, so none is set.
func TestDetectMarksMatchingOff(t *testing.T) {
	s, _ := scopeServer(t)
	collectionTree(t, s, "/Server/Some Category", publicTitles...)
	r := defaultRouting()
	r.Providers = routeSwitches{}
	raw, _ := json.Marshal(r)
	if err := db.SetSetting(s.DB, matchRoutingKey, string(raw)); err != nil {
		t.Fatal(err)
	}
	if !s.matchingOff() {
		t.Fatal("routing setting not honored")
	}
	if marked, _ := detectOnce(t, s); marked != 0 || len(markedPaths(t, s)) != 0 {
		t.Errorf("marked %d with matching off", marked)
	}
}

func TestMarkStateBlocks(t *testing.T) {
	m := markState{stored: map[string]bool{"/a/none": true, "/a/m": true}, active: map[string]bool{"/a/m": true}}
	for p, want := range map[string]bool{"/a/none": true, "/a/m": true, "/a/m/sub": true, "/a": true, "/a/other": false, "/b": false, "/": true} {
		if got := m.blocks(p); got != want {
			t.Errorf("blocks(%q) = %v", p, got)
		}
	}
}
