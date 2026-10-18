package match

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func tmdbCand(local, orig string, year, votes int, format string) anilist.Media {
	var m anilist.Media
	m.ID = 1
	m.Title.Romaji, m.Title.English = local, orig
	m.SeasonYear, m.Popularity, m.Format = year, votes, format
	m.CoverImage.Large = "https://img.example/p.jpg"
	return m
}

func hintInfo(name string) (Info, string) {
	info := ParseName(name, GuessTitle(name), GuessAltTitle(name))
	return info, HintQuery(info)
}

func TestHintAccept(t *testing.T) {
	stub := tmdbCand("Neo Yokio", "Neo Yokio", 2017, 300, "TV")
	stub.CoverImage.Large = ""
	cases := []struct {
		name string
		tier HintTier
		m    anilist.Media
		want bool
	}{
		{"Castlevania [EngDub,GerSub]", HintStrong, tmdbCand("Castlevania", "Castlevania", 2017, 5000, "TV"), true},
		{"Neo Yokio [EngDub,NF]", HintStrong, tmdbCand("Neo Yokio", "Neo Yokio", 2017, 300, "TV"), true},
		{"The Red Turtle [EngDub]", HintStrong, tmdbCand("Die rote Schildkroete", "The Red Turtle", 2016, 900, "MOVIE"), true},
		{"Pacific Rim - The Black [EngDub,NF]", HintStrong, tmdbCand("Pacific Rim: The Black", "Pacific Rim: The Black", 2021, 400, "TV"), true},
		// the candidate has words the folder lacks
		{"Star Wars [EngDub]", HintStrong, tmdbCand("Star Wars Rebels", "Star Wars Rebels", 2014, 2000, "TV"), false},
		// the folder has words the candidate lacks
		{"Neo Yokio Nights [EngDub]", HintStrong, tmdbCand("Neo Yokio", "Neo Yokio", 2017, 300, "TV"), false},
		// a one-word name without any tag vouching for it
		{"Castlevania", HintNormal, tmdbCand("Castlevania", "Castlevania", 2017, 5000, "TV"), false},
		// a one-word name, but nobody rated the candidate
		{"Castlevania [EngDub]", HintStrong, tmdbCand("Castlevania", "Castlevania", 2017, 25, "TV"), false},
		// numbers must match
		{"Example Show 2 [EngDub]", HintStrong, tmdbCand("Example Show", "Example Show", 2017, 500, "TV"), false},
		{"Example Show [EngDub]", HintStrong, tmdbCand("Example Show 3", "Example Show 3", 2017, 500, "TV"), false},
		// a stub: neither poster nor overview
		{"Neo Yokio [EngDub]", HintStrong, stub, false},
		// the folder's year rules out a remake from another decade
		{"Example Show (2021) [EngDub]", HintStrong, tmdbCand("Example Show", "Example Show", 1995, 500, "TV"), false},
		// Japanese audio: no folder word may be missing from the title
		{"Example Show Extra Words Here [JapDub]", HintStrict, tmdbCand("Example Show Extra Words", "Example Show Extra Words", 2017, 500, "TV"), false},
		{"Example Show Extra Words [JapDub]", HintStrict, tmdbCand("Example Show Extra Words", "Example Show Extra Words", 2017, 500, "TV"), true},
	}
	for _, c := range cases {
		info, q := hintInfo(c.name)
		if q == "" {
			if c.want {
				t.Errorf("%q: no query", c.name)
			}
			continue
		}
		if got := HintAccept(info, q, c.m, c.tier); got != c.want {
			t.Errorf("%q vs %q: accept = %v, want %v", c.name, c.m.Title.English, got, c.want)
		}
	}
}

// Folders that name no show never get a query, whatever TMDB holds.
func TestHintQueryRefusesNonTitles(t *testing.T) {
	for _, name := range []string{
		"Movies", "Anime Movies", "Series", "Misc", "Software", "Documentaries", "Music Videos",
		"Studio Collection", "Some Studio - Musicvideos", "Show Collection (Movies)", "BD", "Specials",
		"Notes", "Extras", "ABC", "New Stuff", "Pokemon Specials",
	} {
		if _, q := hintInfo(name); q != "" {
			t.Errorf("%q got the query %q", name, q)
		}
	}
	if _, q := hintInfo("Neo Yokio [EngDub]"); q != "Neo Yokio" {
		t.Errorf("a title lost its query: %q", q)
	}
}
