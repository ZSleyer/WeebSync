package api

import (
	"encoding/json"
	"fmt"
	"testing"
)

// collectionTree files n titles under a folder, each holding one episode.
func collectionTree(t *testing.T, s *Server, parent string, titles ...string) {
	t.Helper()
	for _, name := range titles {
		addRemoteFiles(t, s, 1, parent+"/"+name, map[string]int64{name + " - 01.mkv": 1})
	}
}

var publicTitles = []string{"Cowboy Bebop", "Death Note", "Monster", "Trigun", "Steins Gate", "Mushishi"}

// A folder of single titles is suggested as "auto"; a category root, a folder
// of containers, a music folder and a folder of seasons are not.
func TestCollectionHints(t *testing.T) {
	s, call := scopeServer(t)
	collectionTree(t, s, "/Server/Some Category", publicTitles...)

	// a root whose children are containers of titles
	for _, c := range []string{"Box One", "Box Two", "Box Three", "Box Four", "Box Five"} {
		collectionTree(t, s, "/Server/Some Root/"+c, "Alpha Show", "Beta Show", "Gamma Show", "Delta Show")
	}
	// artists with videos, under a name that says music
	collectionTree(t, s, "/Server/Music Videos", publicTitles...)
	// a show whose subfolders are its seasons
	for i := 1; i <= 6; i++ {
		addRemoteFiles(t, s, 1, fmt.Sprintf("/Server/Some Show/Season %d", i), map[string]int64{"Some Show - 01.mkv": 1})
	}
	// folders without any video are no titles
	for _, n := range publicTitles {
		addRemoteFiles(t, s, 1, "/Server/Some Documents Dump/"+n, map[string]int64{"notes.txt": 1})
	}
	// too few subfolders
	collectionTree(t, s, "/Server/Small Category", publicTitles[:4]...)

	hints := func() (out []scopeHint) {
		s.collCache.by = nil // the scan is cached for minutes
		var hs []scopeHint
		json.Unmarshal(call("GET", "/api/catalog/scope-hints", "").Body.Bytes(), &hs)
		for _, h := range hs {
			if h.Reason == "collection" {
				out = append(out, h)
			}
		}
		return out
	}
	got := hints()
	if len(got) != 1 || got[0].Path != "/Server/Some Category" || got[0].Kind != "auto" ||
		got[0].Titles != 6 || got[0].Total != 6 || got[0].AltKind != "" || got[0].ServerName != "seedbox" {
		t.Fatalf("hints = %+v", got)
	}

	// a stored "none" is a dismissal that stays
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"none"}`)
	if got := hints(); len(got) != 0 {
		t.Fatalf("after dismissing: %+v", got)
	}
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":""}`)
	if got := hints(); len(got) != 1 {
		t.Fatalf("cleared again: %+v", got)
	}
	// marked, or inside a mark, it is no suggestion
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":"auto"}`)
	if got := hints(); len(got) != 0 {
		t.Fatalf("marked: %+v", got)
	}
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server/Some Category","kind":""}`)
	call("PUT", "/api/servers/1/catalog/scope", `{"path":"/Server","kind":"anime"}`)
	if got := hints(); len(got) != 0 {
		t.Fatalf("inside a mark: %+v", got)
	}
}

// Japanese or anime-service tags on the titles offer "Anime" as well.
func TestCollectionHintsAnime(t *testing.T) {
	s, call := scopeServer(t)
	var tagged []string
	for _, n := range publicTitles {
		tagged = append(tagged, n+" [JapDub,GerSub,CR]")
	}
	collectionTree(t, s, "/Server/Some Category", tagged...)
	var hs []scopeHint
	json.Unmarshal(call("GET", "/api/catalog/scope-hints", "").Body.Bytes(), &hs)
	if len(hs) != 1 || hs[0].AltKind != "anime" || hs[0].Kind != "auto" {
		t.Fatalf("hints = %+v", hs)
	}
}

func TestJudgeCollection(t *testing.T) {
	ep := []indexEntry{{"x - 01.mkv", false}}
	listing := map[string][]indexEntry{}
	var kids []string
	add := func(n string, e []indexEntry) { kids = append(kids, n); listing[n] = e }
	for _, n := range publicTitles {
		add(n, ep)
	}
	add("Some Category Box", []indexEntry{{"A", true}, {"B", true}, {"C", true}}) // a container
	add(".hidden", ep)                                                            // a helper, not counted
	titles, total, _, ok := judgeCollection(kids, listing)
	if !ok || titles != 6 || total != 7 {
		t.Errorf("6 of 7 titles: %d/%d %v", titles, total, ok)
	}
	add("Another Box", nil) // an unlisted folder counts against it
	add("Third Box", nil)
	if _, _, _, ok := judgeCollection(kids, listing); ok {
		t.Error("6 of 9 is below the share")
	}
}
