package api

import (
	"testing"
	"unicode/utf16"
)

func pieceOf(r nameExplainResponse, kind string) (namePiece, bool) {
	for _, p := range r.Pieces {
		if p.Kind == kind {
			return p, true
		}
	}
	return namePiece{}, false
}

// slice16 cuts s by UTF-16 offsets, the way the browser will.
func slice16(s string, a, b int) string {
	u := utf16.Encode([]rune(s))
	return string(utf16.Decode(u[a:b]))
}

func TestExplainName(t *testing.T) {
	cases := []struct {
		name string
		want map[string]string // kind -> text at its position
	}{
		{"Kusuriya no Hitorigoto 3rd Season (The Apothecary Diaries S3) [GerJapDub,GerEngSub,CR]",
			map[string]string{"title": "Kusuriya no Hitorigoto", "season": "3rd Season", "dub": "GerJapDub", "sub": "GerEngSub", "tag": "CR"}},
		{"The Apothecary Diaries - S03E01v2.mkv",
			map[string]string{"episode": "E01", "version": "v2", "extension": "mkv"}},
		{"[Group] Frieren - 07 [1080p].mkv",
			map[string]string{"group": "Group", "episode": "07", "resolution": "1080p"}},
		{"Skyscraper (2018) [GerDub]", map[string]string{"year": "2018", "dub": "GerDub"}},
		{"Chäos;Child S2 [GerSub]", map[string]string{"season": "S2", "sub": "GerSub"}},
	}
	for _, c := range cases {
		r := explainName(c.name)
		for kind, text := range c.want {
			p, ok := pieceOf(r, kind)
			if !ok {
				t.Errorf("%q: no %s piece in %+v", c.name, kind, r.Pieces)
				continue
			}
			if p.Start < 0 {
				t.Errorf("%q: %s has no position", c.name, kind)
				continue
			}
			if got := slice16(c.name, p.Start, p.End); got != text {
				t.Errorf("%q: %s at %d..%d = %q, want %q", c.name, kind, p.Start, p.End, got, text)
			}
		}
		// pieces never overlap and come in name order
		last := 0
		for _, p := range r.Pieces {
			if p.Start < 0 {
				continue
			}
			if p.Start < last {
				t.Errorf("%q: piece %s at %d overlaps or is out of order (last end %d)", c.name, p.Kind, p.Start, last)
			}
			last = p.End
		}
	}
	if r := explainName("Kusuriya no Hitorigoto 3rd Season [GerDub]"); r.Parse.Season != 3 {
		t.Errorf("parse season = %d, want 3", r.Parse.Season)
	}
}
