package match

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func TestNonTitle(t *testing.T) {
	for name, want := range map[string]bool{
		"Anime Movies":           true,
		"Music Videos":           true,
		"Downloads":              true,
		"Some Show Collection":   true,
		"Season 2":               true,
		"Death Note":             false,
		"New Game!":              false, // one category word among others is a title
		"Dr. Stone":              false,
		"Example Story [JapDub]": false,
	} {
		info := ParseName(name, GuessTitle(name), GuessAltTitle(name))
		if got := NonTitle(info); got != want {
			t.Errorf("NonTitle(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestFirstPickOK(t *testing.T) {
	film := tmdbCand("Example Story", "Example Story", 0, 500, "MOVIE")
	music := tmdbCand("Example Story", "Example Story", 2019, 500, "MUSIC")
	tv := tmdbCand("Example Story", "Example Story", 2019, 500, "TV")
	longer := tmdbCand("Tiny Example Story", "Tiny Example Story", 2019, 500, "TV")
	sub := tmdbCand("Example Story: The Long Subtitle Of It All", "Example Story", 2019, 500, "TV")
	for _, c := range []struct {
		name   string
		m      anilist.Media
		tagged bool
		want   bool
	}{
		{"Example Story (2019)", tv, false, true},
		{"Example Story", film, true, true},          // no year asked, none needed
		{"Example Story (2019)", film, true, false},  // the folder names a year the entry cannot confirm
		{"Example Story (2019)", music, true, false}, // a music video the folder does not speak of
		{"Example Story Music Videos (2019)", music, true, true},
		// a name with no tags, the way a media server files it: the entry may not be more than the name
		{"Example Story (2019)", longer, false, false},
		{"Example Story (2019)", longer, true, true},
		{"Example Story (2019)", sub, false, true}, // its subtitle is left out of the folder name
	} {
		info := ParseName(c.name, GuessTitle(c.name), GuessAltTitle(c.name))
		if got := FirstPickOK(info, c.m, c.tagged); got != c.want {
			t.Errorf("FirstPickOK(%q, %q, tagged %v) = %v, want %v", c.name, c.m.Title.Romaji, c.tagged, got, c.want)
		}
	}
}

// AutoAccept is the gate for a provider asked after the first: seasons may
// ride along, a title that is more or less than the folder's is refused, and
// a provider without votes is held to its poster instead.
func TestAutoAccept(t *testing.T) {
	cases := []struct {
		name  string
		tier  HintTier
		m     anilist.Media
		votes bool
		want  bool
	}{
		{"Example Story S2", HintNormal, tmdbCand("Example Story", "Example Story", 2017, 500, "TV"), true, true},
		{"Example Story 2nd Season [JapDub]", HintStrict, tmdbCand("Example Story 2nd Season", "Example Story 2nd Season", 2018, 500, "TV"), true, true},
		{"Example Story Extra Words [JapDub]", HintStrict, tmdbCand("Example Story Extra", "Example Story Extra", 2017, 500, "TV"), true, false},
		{"Example Story", HintNormal, tmdbCand("Example Story Returns", "Example Story Returns", 2017, 500, "TV"), true, false},
		{"Example Story OVA", HintNormal, tmdbCand("Example Story", "Example Story", 2017, 500, "TV"), true, false},
		{"Example Story", HintNormal, tmdbCand("Example Story", "Example Story", 2017, 3, "TV"), true, false},
		{"Example Story", HintNormal, tmdbCand("Example Story", "Example Story", 2017, 0, "TV"), false, true},
		{"Castlevania", HintNormal, tmdbCand("Castlevania", "Castlevania", 2017, 5000, "TV"), true, false},
		{"Castlevania (2017)", HintNormal, tmdbCand("Castlevania", "Castlevania", 2017, 5000, "TV"), true, true},
	}
	for _, c := range cases {
		info := ParseName(c.name, GuessTitle(c.name), GuessAltTitle(c.name))
		if got := AutoAccept(info, HintQuery(info), c.m, c.tier, c.votes); got != c.want {
			t.Errorf("AutoAccept(%q, %q) = %v, want %v", c.name, c.m.Title.Romaji, got, c.want)
		}
	}
}
