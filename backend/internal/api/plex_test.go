package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func media(id, eps int, format, status string) anilist.Media {
	m := anilist.Media{ID: id, Episodes: eps, Format: format, Status: status}
	m.Title.Romaji = "Test Show"
	return m
}

func TestMissingSequel(t *testing.T) {
	s1 := media(1, 12, "TV", "FINISHED")
	s2 := media(2, 12, "TV", "FINISHED")
	s3 := media(3, 0, "TV", "RELEASING") // unknown count, counts as 1
	rels := map[int][]anilist.Relation{
		1: {{RelationType: "SEQUEL", Node: s2}, {RelationType: "SOURCE", Node: media(9, 0, "MANGA", "FINISHED")}},
		2: {{RelationType: "SEQUEL", Node: s3}},
	}
	chain := walkChain(s1, rels)
	if len(chain) != 3 {
		t.Fatalf("chain length %d", len(chain))
	}
	cases := []struct {
		leaf   int
		wantID int // 0 = no suggestion
	}{
		{12, 2}, // only season 1 present → suggest season 2
		{20, 2}, // season 2 partial → still suggest it
		{24, 3}, // seasons 1+2 complete → suggest airing season 3
		{25, 0}, // everything present
	}
	for _, c := range cases {
		got, _ := missingSequel(chain, c.leaf)
		gotID := 0
		if got != nil {
			gotID = got.ID
		}
		if gotID != c.wantID {
			t.Errorf("leaf %d: got %d, want %d", c.leaf, gotID, c.wantID)
		}
	}
	// movie sequels and unaired seasons never enter the chain
	rels[3] = []anilist.Relation{
		{RelationType: "SEQUEL", Node: media(4, 1, "MOVIE", "FINISHED")},
		{RelationType: "SEQUEL", Node: media(5, 12, "TV", "NOT_YET_RELEASED")},
	}
	if chain := walkChain(s1, rels); len(chain) != 3 {
		t.Errorf("movie/unaired in chain: %d", len(chain))
	}
}

func TestSignificantWords(t *testing.T) {
	got := significantWords("Youjo Senki II: Saga of Tanya", 3)
	if len(got) != 3 || got[0] != "Youjo" || got[1] != "Senki" || got[2] != "Saga" {
		t.Errorf("got %v", got)
	}
	if w := significantWords("", 3); len(w) != 0 {
		t.Errorf("empty title: %v", w)
	}
}
