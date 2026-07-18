package match

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func media(id int, romaji, english, format string, year int) anilist.Media {
	var m anilist.Media
	m.ID = id
	m.Title.Romaji = romaji
	m.Title.English = english
	m.Format = format
	m.SeasonYear = year
	return m
}

// Fixtures are the real cached AniList search payloads from a dev database
// (anilist_cache, keys "search:<query>"), reduced to the fields Pick reads.
var (
	quintuplets = []anilist.Media{
		media(103572, "Go-toubun no Hanayome", "The Quintessential Quintuplets", "TV", 2019),
		media(109261, "Go-toubun no Hanayome ∬", "The Quintessential Quintuplets 2", "TV", 2021),
		media(163327, "Go-toubun no Hanayome∽", "The Quintessential Quintuplets Specials", "SPECIAL", 2023),
		media(131520, "Go-toubun no Hanayome Movie", "The Quintessential Quintuplets Movie", "MOVIE", 2022),
	}
	heroAcademia = []anilist.Media{
		media(21459, "Boku no Hero Academia", "My Hero Academia", "TV", 2016),
		media(163139, "Boku no Hero Academia 7", "My Hero Academia Season 7", "TV", 2024),
		media(139630, "Boku no Hero Academia 6", "My Hero Academia Season 6", "TV", 2022),
		media(182896, "Boku no Hero Academia FINAL SEASON", "My Hero Academia FINAL SEASON", "TV", 2025),
		media(21856, "Boku no Hero Academia 2", "My Hero Academia Season 2", "TV", 2017),
		media(100166, "Boku no Hero Academia 3", "My Hero Academia Season 3", "TV", 2018),
		media(104276, "Boku no Hero Academia 4", "My Hero Academia Season 4", "TV", 2019),
		media(117193, "Boku no Hero Academia 5", "My Hero Academia Season 5", "TV", 2021),
		media(149073, "Boku no Hero Academia 5 (ONA)", "My Hero Academia Season 5 OVA", "ONA", 2022),
		media(108553, "Boku no Hero Academia THE MOVIE: Heroes:Rising", "My Hero Academia: Heroes Rising", "MOVIE", 2019),
	}
	fruitsBasket = []anilist.Media{
		media(120, "Fruits Basket", "Fruits Basket", "TV", 2001),
		media(124194, "Fruits Basket: The Final", "Fruits Basket The Final Season", "TV", 2021),
		media(105334, "Fruits Basket: 1st Season", "Fruits Basket (2019)", "TV", 2019),
		media(111762, "Fruits Basket: 2nd Season", "Fruits Basket Season 2", "TV", 2020),
		media(136192, "Fruits Basket: prelude", "Fruits Basket -prelude-", "MOVIE", 2022),
	}
	psychoPass = []anilist.Media{
		media(13601, "PSYCHO-PASS", "PSYCHO-PASS", "TV", 2012),
		media(108307, "PSYCHO-PASS 3", "PSYCHO-PASS 3", "TV", 2019),
		media(20513, "PSYCHO-PASS 2", "PSYCHO-PASS 2", "TV", 2014),
		media(20514, "PSYCHO-PASS Movie", "PSYCHO-PASS: The Movie", "MOVIE", 2015),
		media(153687, "PSYCHO-PASS PROVIDENCE", "PSYCHO-PASS: Providence", "MOVIE", 2023),
		media(113917, "PSYCHO-PASS 3: FIRST INSPECTOR", "PSYCHO-PASS 3: First Inspector", "ONA", 2020),
		media(104382, "PSYCHO-PASS Sinners of the System Case 2: First Guardian", "PSYCHO-PASS: Sinners of the System 2 - First Guardian", "MOVIE", 2019),
		media(102649, "PSYCHO-PASS Sinners of the System Case 1: Tsumi to Batsu", "PSYCHO-PASS: Sinners of the System 1 - Crime and Punishment", "MOVIE", 2019),
	}
	noGunsLife = []anilist.Media{
		media(108478, "No Guns Life", "No Guns Life", "TV", 2019),
		media(112803, "No Guns Life 2", "No Guns Life Season 2", "TV", 2020),
		media(124014, "No Guns Life Mini", "", "ONA", 0),
		media(124027, `Jikai Yokoku "No Guns Life"`, "", "ONA", 0),
	}
	haikyuu = []anilist.Media{
		media(20464, "Haikyuu!!", "HAIKYU!!", "TV", 2014),
		media(21698, "Haikyuu!!: Karasuno Koukou VS Shiratorizawa Gakuen Koukou", "HAIKYU!! 3rd Season", "TV", 2016),
		media(20884, "Haikyuu!!: Lev Kenzan!", "HAIKYU!!: Lev Appears!", "OVA", 2014),
		media(21348, "Haikyuu!!: VS Akaten", "HAIKYU!!: VS Failing Marks", "SPECIAL", 2015),
		media(111790, "Haikyuu!! Riku VS Kuu", "HAIKYU!! LAND VS. AIR", "OVA", 2020),
		media(153658, "Haikyuu!!: Gomi Suteba no Kessen", "HAIKYU!! The Dumpster Battle", "MOVIE", 2024),
		media(20992, "Haikyuu!! 2nd Season", "HAIKYU!! 2nd Season", "TV", 2015),
		media(106625, "Haikyuu!! TO THE TOP", "HAIKYU!! TO THE TOP", "TV", 2020),
	}
	// live AniList results (the dev cache has only empty lists for these
	// queries - that is the bug the normalize fallback fixes)
	yamiShibai = []anilist.Media{
		media(19383, "Yami Shibai", "Theatre of Darkness: Yamishibai", "TV_SHORT", 2013),
		media(109603, "Yami Shibai 7", "Theatre of Darkness: Yamishibai 7", "TV_SHORT", 2019),
		media(21473, "Yami Shibai 3", "Theatre of Darkness: Yamishibai 3", "TV_SHORT", 2016),
		media(142826, "Yami Shibai 10", "Theatre of Darkness: Yamishibai 10", "TV_SHORT", 2022),
		media(177922, "Yami Shibai 13", "Theatre of Darkness: Yamishibai 13", "TV_SHORT", 2024),
		media(203939, "Yami Shibai 16", "Theatre of Darkness: Yamishibai 16", "TV_SHORT", 2026),
	}
	fireForce = []anilist.Media{
		media(105310, "Enen no Shouboutai", "Fire Force", "TV", 2019),
		media(114236, "Enen no Shouboutai: Ni no Shou", "Fire Force Season 2", "TV", 2020),
		media(149118, "Enen no Shouboutai: San no Shou", "Fire Force Season 3", "TV", 2025),
		media(128390, "Enen no Shouboutai Mini Anime", "", "ONA", 2021),
		media(179062, "Enen no Shouboutai: San no Shou Part 2", "Fire Force Season 3 Part 2", "TV", 2026),
	}
)

func pick(t *testing.T, name string, list []anilist.Media) (anilist.Media, bool) {
	t.Helper()
	info := ParseName(name, GuessTitle(name), GuessAltTitle(name))
	idx, ok := Pick(info, list)
	return list[idx], ok
}

func TestPick(t *testing.T) {
	cases := []struct {
		name string
		list []anilist.Media
		want int
	}{
		{"5-toubun no Hanayome S2 [GerSub]", quintuplets, 109261},
		{"5-toubun no Hanayome (The Quintessential Quintuplets Movie) [GerDub]", quintuplets, 131520},
		{"5-toubun no Hanayome [GerDub,GerSub]", quintuplets, 103572},
		{"Boku no Hero Academia S3 (My Hero Academia S3) [GerDub]", heroAcademia, 100166},
		{"Boku no Hero Academia [GerDub,GerSub]", heroAcademia, 21459},
		{"Fruits Basket S2 [GerSub]", fruitsBasket, 111762},
		{"Fruits Basket [GerDub,GerSub]", fruitsBasket, 120},
		{"Yami Shibai 10 [GerSub]", yamiShibai, 142826},
		{"Yami Shibai [GerSub]", yamiShibai, 19383},
		{"En'en no Shouboutai Ni no Shou (Fire Force S2) [GerDub]", fireForce, 114236},
		{"No Guns Life II [GerDub,GerEngSub]", noGunsLife, 112803},
		{"Psycho-Pass 2 [GerDub,GerSub]", psychoPass, 20513},
		{"Psycho-Pass [GerDub,GerSub]", psychoPass, 13601},
	}
	for _, c := range cases {
		got, ok := pick(t, c.name, c.list)
		if !ok || got.ID != c.want {
			t.Errorf("Pick(%q) = %d (confident=%v), want %d", c.name, got.ID, ok, c.want)
		}
	}
}

func TestPickOVA(t *testing.T) {
	// the OVA-format candidate must beat the TV base entry
	got, ok := pick(t, "Haikyu OVA [GerSub]", haikyuu)
	if !ok || !ovaFormats[got.Format] {
		t.Errorf("Pick(Haikyu OVA) = %d format %s (confident=%v), want an OVA/SPECIAL/ONA entry", got.ID, got.Format, ok)
	}
}

func TestPickNotConfident(t *testing.T) {
	// an explicit-sequel folder must not fall back to an implausible base
	if _, ok := pick(t, "Kingdom S3 [GerSub]", fruitsBasket); ok {
		t.Error("Pick(Kingdom S3, fruits basket results) confident, want not confident")
	}
	if _, ok := Pick(Info{Title: "Show", Full: "Show"}, nil); ok {
		t.Error("Pick with empty list confident, want not confident")
	}
	// season-less folders keep today's behavior: any result is accepted
	if _, ok := pick(t, "Kingdom [GerSub]", fruitsBasket); !ok {
		t.Error("Pick(Kingdom, fruits basket results) not confident, want confident (backward compat)")
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"Akiba’s Trip":              "akiba's trip",
		"Chäos;Child":               "chaos child",
		"Märchen Mädchen":           "marchen madchen",
		"  PSYCHO-PASS:  The Movie": "psycho pass the movie",
		"BULLET/BULLET":             "bullet bullet",
		"Weiß Survive":              "weiss survive",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSeasonOf(t *testing.T) {
	cases := []struct {
		romaji, english string
		want            int
	}{
		{"Boku no Hero Academia 2", "My Hero Academia Season 2", 2},
		{"Fruits Basket: 2nd Season", "Fruits Basket Season 2", 2},
		{"Go-toubun no Hanayome ∬", "The Quintessential Quintuplets 2", 2},
		{"Boku no Hero Academia FINAL SEASON", "My Hero Academia FINAL SEASON", -1},
		{"Boku no Hero Academia", "My Hero Academia", 0},
		{"No Guns Life", "No Guns Life", 0},
		{"No Guns Life 2", "No Guns Life Season 2", 2},
		{"Enen no Shouboutai: Ni no Shou", "Fire Force Season 2", 2},
		{"Haikyuu!!: Karasuno Koukou VS Shiratorizawa Gakuen Koukou", "HAIKYU!! 3rd Season", 3},
		{"Steins;Gate 0", "Steins;Gate 0", 0}, // trailing 0/1 is no season
	}
	for _, c := range cases {
		if got := SeasonOf(media(1, c.romaji, c.english, "TV", 0)); got != c.want {
			t.Errorf("SeasonOf(%q / %q) = %d, want %d", c.romaji, c.english, got, c.want)
		}
	}
}

func TestParseName(t *testing.T) {
	cases := []struct {
		name   string
		season int
		movie  bool
		ova    bool
	}{
		{"5-toubun no Hanayome S2 [GerSub]", 2, false, false},
		{"Fruits Basket 2nd Season [GerSub]", 2, false, false},
		{"No Guns Life II [GerDub]", 2, false, false},
		{"En'en no Shouboutai Ni no Shou (Fire Force S2) [GerDub]", 2, false, false},
		{"5-toubun no Hanayome (The Quintessential Quintuplets Movie) [GerDub]", 0, true, false},
		{"Haikyu OVA [GerSub]", 0, false, true},
		{"Yami Shibai 10 [GerSub]", 0, false, false}, // bare trailing digit is a title
		{"Psycho-Pass 2 [GerDub]", 0, false, false},
	}
	for _, c := range cases {
		info := ParseName(c.name, GuessTitle(c.name), GuessAltTitle(c.name))
		if info.Season != c.season || info.Movie != c.movie || info.OVA != c.ova {
			t.Errorf("ParseName(%q) = season %d movie %v ova %v, want %d %v %v",
				c.name, info.Season, info.Movie, info.OVA, c.season, c.movie, c.ova)
		}
	}
}

func TestStripMarkers(t *testing.T) {
	cases := map[string]string{
		"Boku no Hero Academia S3":  "Boku no Hero Academia",
		"Fruits Basket: 2nd Season": "Fruits Basket:",
		"No Guns Life II":           "No Guns Life",
		"Haikyu OVA":                "Haikyu",
		"Yami Shibai":               "Yami Shibai",
	}
	for in, want := range cases {
		if got := StripMarkers(in); got != want {
			t.Errorf("StripMarkers(%q) = %q, want %q", in, got, want)
		}
	}
}
