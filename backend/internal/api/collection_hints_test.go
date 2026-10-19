package api

import (
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
