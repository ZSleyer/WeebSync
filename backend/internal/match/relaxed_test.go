package match

import (
	"reflect"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func nameInfo(name string) Info {
	return ParseName(name, GuessTitle(name), GuessAltTitle(name))
}

func syn(m anilist.Media, s ...string) anilist.Media {
	m.Synonyms = s
	return m
}

func TestRelaxedQueries(t *testing.T) {
	cases := []struct {
		name string
		want []string
	}{
		{"ReZero kara Hajimeru Isekai Seikatsu [JapDub,CR]", []string{"Re:Zero kara Hajimeru Isekai Seikatsu", "Re:Zero kara Hajimeru", "Re:Zero kara"}},
		{"Princess Connect! ReDive S2 [JapDub,CR]", []string{"Princess Connect! Re:Dive", "Princess Connect!"}},
		{"Chain Chronicle - Haecceitas no Hikari TV Version [CR]", []string{"Chain Chronicle", "Chain Chronicle - Haecceitas no Hikari", "Chain Chronicle - Haecceitas", "Chain Chronicle -"}},
		{"Spy x Family Part 2 [CR]", []string{"Spy × Family"}},
		{"Shin Shirayukihime Densetsu Pretear (Pretear) [CR]", []string{"Shin Shirayukihime Densetsu", "Shin Shirayukihime", "Pretear"}},
		{"Made in Abyss Movies [WKN]", nil},
		{"ReZERO -Starting Life in Another World- Shorts [CR]", nil},
	}
	for _, c := range cases {
		info := nameInfo(c.name)
		got := RelaxedQueries(info.Full, []string{info.Title}, 4)
		if len(got) > 4 {
			t.Errorf("%q: %d queries, the bound is 4", c.name, len(got))
		}
		if len(c.want) > 0 && (len(got) == 0 || got[0] != c.want[0]) {
			t.Errorf("%q: first query %q, want %q (all: %q)", c.name, got, c.want[0], got)
		}
		if c.want == nil && got != nil {
			t.Errorf("%q: got %q, want none", c.name, got)
		}
	}
	info := nameInfo("ReZero kara Hajimeru Isekai Seikatsu")
	if got := RelaxedQueries(info.Full, []string{"ReZero kara Hajimeru Isekai Seikatsu"}, 4)[0]; got != "Re:Zero kara Hajimeru Isekai Seikatsu" {
		t.Errorf("Re rewrite: %q", got)
	}
	// a category or a family name is no query: two words and 8 letters at least
	for _, n := range []string{"Some Category - Videos", "Another Category", "Misc Stuff", "Hello!", "Dr. Stone - Ryuusu", "Endless Anime"} {
		i := nameInfo(n)
		for _, q := range RelaxedQueries(i.Full, []string{i.Title}, 4) {
			if len(strings.Fields(q)) < 2 || letterCount(q) < relaxedMinLetters {
				t.Errorf("%q: query %q is too generic", n, q)
			}
		}
	}
	// no cut ends on a particle, no entry without a year serves a folder with one
	i := nameInfo("Star Wars The Clone Wars (2008)")
	for _, q := range RelaxedQueries(i.Full, []string{i.Title}, 4) {
		if strings.HasSuffix(q, " The") {
			t.Errorf("fragment query %q", q)
		}
	}
	if RelaxedAccept(i, "Star Wars", media(9, "Star Wars: The Clone Wars Special", "", "ONA", 0)) {
		t.Error("an entry without a year took a folder with one")
	}
	// nothing is tried twice
	info = nameInfo("Alpha Bravo Charlie Delta")
	got := RelaxedQueries(info.Full, []string{"Alpha Bravo Charlie Delta", "Alpha Bravo Charlie"}, 4)
	if !reflect.DeepEqual(got, []string{"Alpha Bravo"}) {
		t.Errorf("tried query repeated: %q", got)
	}
}

func TestRelaxedAccept(t *testing.T) {
	tv := func(id int, romaji, english string) anilist.Media { return media(id, romaji, english, "TV", 2020) }
	cases := []struct {
		name, query string
		cand        anilist.Media
		want        bool
	}{
		{"ReZero kara Hajimeru Isekai Seikatsu", "Re:Zero kara Hajimeru Isekai Seikatsu",
			tv(1, "Re:Zero kara Hajimeru Isekai Seikatsu", "Re:ZERO -Starting Life in Another World-"), true},
		{"Princess Connect! ReDive S2", "Princess Connect! Re:Dive",
			tv(2, "Princess Connect! Re:Dive", ""), true},
		{"Chain Chronicle - Haecceitas no Hikari TV Version", "Chain Chronicle",
			tv(3, "Chain Chronicle: Haecceitas no Hikari", "Chain Chronicle: The Light of Haecceitas"), true},
		{"Shin Shirayukihime Densetsu Pretear (Pretear)", "Pretear",
			tv(4, "Shin Shirayukihime Densetsu Pretear", "Princess Tutu"), true},
		{"Watashi ga Motete Dou Sunda", "Watashi ga Motete",
			tv(5, "Watashi ga Motete Dousunda", "Why Do I Get Popular"), true},
		{"Ore o Suki na no wa Omae dake ka yo (Oresuki)", "Oresuki",
			syn(tv(6, "Ore wo Suki nano wa Omae dake ka yo", "Oresuki: Are you the only one who loves me?"), "Oresuki"), true},
		// siblings and fragments that must stay unmatched
		{"Dr. Stone - Ryuusu", "Dr. Stone", tv(10, "Dr. Stone", "Dr. Stone"), false},
		{"Boku no Hero Academia - Memories", "Boku no Hero Academia", tv(11, "Boku no Hero Academia", "My Hero Academia"), false},
		{"Ai-Mai-Mi Mousou Surgical Friends", "Ai Mai Mi", tv(12, "Ai-Mai-Mi Mousou Catastrophe", ""), false},
		{"Tenchi Muyou! Ryououki Dai Yon-ki", "Tenchi Muyou! Ryououki", tv(13, "Tenchi Muyou! Ryououki Dai 1-ki", ""), false},
		{"UQ Holder! Magister Negi Magi Negima! 2", "UQ Holder!", tv(14, "UQ Holder! Mahou Sensei Negima! 2", ""), false},
		{"Tesagure! Bukatsumomo Encore", "Tesagure! Bukatsumomo", tv(15, "Tesagure! Bukatsumomo", ""), false},
		{"Foo Bar", "Foo", tv(16, "Foo Bar 2nd Season", ""), false},
		{"Star Wars Rebels", "Star Wars", tv(19, "Star Wars: Visions", ""), false}, // a short title misses nothing
		{"Foo Bar", "Foo", tv(17, "Foo Bar Final Season", ""), false},
		{"Foo Bar", "Alpha Bravo Charlie", tv(18, "Foo Bar", ""), false},
	}
	for _, c := range cases {
		if got := RelaxedAccept(nameInfo(c.name), c.query, c.cand); got != c.want {
			t.Errorf("%q query %q vs %q: accepted %v, want %v", c.name, c.query, c.cand.Title.Romaji, got, c.want)
		}
	}
}

func TestWithinOne(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"eyes", "eye", true}, {"dive", "dive", true}, {"hachi", "hakkei", false},
		{"stone", "stune", true}, {"stone", "stinu", false}, {"abc", "abcde", false},
	} {
		if got := withinOne(c.a, c.b); got != c.want {
			t.Errorf("withinOne(%q, %q) = %v", c.a, c.b, got)
		}
	}
}
