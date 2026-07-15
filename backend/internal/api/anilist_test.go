package api

import "testing"

func TestGuessTitle(t *testing.T) {
	cases := []struct{ name, title, alt string }{
		{"Long Zhi Nu Hou (Roar of the Hundred Dragons) [ChiDub,GerEngSub,CR]", "Long Zhi Nu Hou", "Roar of the Hundred Dragons"},
		{"Idol Live! YUME∞STAGE [JapDub,GerEngSub,CR]", "Idol Live! YUME∞STAGE", ""},
		{"Velgarion II [GerJapDub,GerEngSub,CR]", "Velgarion II", ""},
		{"Heroine Kishi Iie, All Works Butler desu (Ko)! (Heroine Knight) [JapDub,CR]", "Heroine Kishi Iie, All Works Butler desu !", "Heroine Knight"},
		{"Show (2022) [WEBDL-1080p]", "Show", ""},
		{"[Group] Some Title - 01 [1080p]", "Some Title", ""},
	}
	for _, c := range cases {
		if got := GuessTitle(c.name); got != c.title {
			t.Errorf("GuessTitle(%q) = %q, want %q", c.name, got, c.title)
		}
		if got := GuessAltTitle(c.name); got != c.alt {
			t.Errorf("GuessAltTitle(%q) = %q, want %q", c.name, got, c.alt)
		}
	}
}

func TestSeasonFromPath(t *testing.T) {
	cases := []struct {
		path   string
		season string
		year   int
	}{
		{"/data/Anime-Server/2026-3 Summer/Show Name", "SUMMER", 2026},
		{"/data/Anime-Server/2025-4 Fall/Show", "FALL", 2025},
		{"/x/2026-1 Winter/Show", "WINTER", 2026},
		{"/x/2026-2 Spring/Show", "SPRING", 2026},
		{"/data/Anime-Cloud/WEB/Show", "", 0},
		{"/data/Show 1998-2 Remaster", "SPRING", 1998}, // segment match, by design
		{"/data/BD [Fansub & Remux]/Show (2020)", "", 0},
	}
	for _, c := range cases {
		s, y := seasonFromPath(c.path)
		if s != c.season || y != c.year {
			t.Errorf("seasonFromPath(%q) = %q,%d want %q,%d", c.path, s, y, c.season, c.year)
		}
	}
}
