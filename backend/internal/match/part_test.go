package match

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func TestInstallmentMarkers(t *testing.T) {
	for name, want := range map[string]int{
		"Spy x Family Part 2 [JapDub,CR]":                              2,
		"Active Raid - Kidou Kyoushuushitsu Dai Hachi Gakari 2nd [CR]": 0, // a title until a search says otherwise (TrailingOrdinal)
		"Major 2nd [CR]":                                0,
		"Senki Zesshou Symphogear -2- G [CR]":           2,
		"Senki Zesshou Symphogear -5- XV [CR]":          5,
		"Show Part 1 [CR]":                              0, // the first part is no sequel
		"Show 1st [CR]":                                 0,
		"Show S3 Part 2 [CR]":                           3, // the season marker wins
		"Evangelion 1.11-3.33":                          0,
		"Re:Zero -Starting Life in Another World- [CR]": 0,
	} {
		if got := ParseName(name, GuessTitle(name), GuessAltTitle(name)).Season; got != want {
			t.Errorf("ParseName(%q).Season = %d, want %d", name, got, want)
		}
	}
}

func TestTrailingOrdinal(t *testing.T) {
	for in, want := range map[string]int{"Dai Hachi Gakari 2nd": 2, "Foo 3rd": 3, "Foo 1st": 0, "Major": 0, "2nd Foo": 0} {
		if got := TrailingOrdinal(in); got != want {
			t.Errorf("TrailingOrdinal(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestStripFolderMarkers(t *testing.T) {
	for in, want := range map[string]string{
		"Spy x Family Part 2":                      "Spy x Family",
		"Dai Hachi Gakari 2nd":                     "Dai Hachi Gakari",
		"Senki Zesshou Symphogear -2- G":           "Senki Zesshou Symphogear G",
		"Boku no Hero Academia S3":                 "Boku no Hero Academia",
		"Re:Zero -Starting Life in Another World-": "Re:Zero -Starting Life in Another World-",
	} {
		if got := StripFolderMarkers(in); got != want {
			t.Errorf("StripFolderMarkers(%q) = %q, want %q", in, got, want)
		}
	}
}

// AniList files "Part 2" as an entry of its own; for a folder that names it
// the entry is the season, and the first part is not.
func TestPartTwoIsASeason(t *testing.T) {
	list := []anilist.Media{
		media(1, "SPY×FAMILY", "SPY x FAMILY", "TV", 2022),
		media(2, "SPY×FAMILY Part 2", "SPY x FAMILY Cour 2", "TV", 2022),
		media(3, "SPY×FAMILY Season 2", "SPY x FAMILY Season 2", "TV", 2023),
	}
	name := "Spy x Family Part 2 [JapDub,CR]"
	if i, ok := Pick(ParseName(name, GuessTitle(name), GuessAltTitle(name)), list); i != 1 || !ok {
		t.Errorf("Pick = %d %v, want the Part 2 entry", i, ok)
	}
	// "Season 3 Part 2" is not the Part 2 of a folder at season 4
	name = "Shingeki no Kyojin S4 Part 2"
	_, _, sc := PickExplain(ParseName(name, GuessTitle(name), GuessAltTitle(name)),
		[]anilist.Media{media(1, "Shingeki no Kyojin Season 3 Part 2", "", "TV", 2019)})
	for _, s := range sc[0].Signals {
		if s.Code == "part" {
			t.Errorf("Season 3 Part 2 credited as Part 2 of season 4: %+v", sc[0])
		}
	}
}

// Without a marker in the folder, "Part N" in an entry is no season: films
// and specials of that name keep the score they had.
func TestPartInEntryIsNoSeasonForPlainFolder(t *testing.T) {
	list := []anilist.Media{
		media(1, "Donten ni Warau Gaiden: Ketsubetsu", "Laughing Under the Clouds: Gaiden Part 1", "MOVIE", 2017),
		media(2, "Donten ni Warau Gaiden: Shukumei", "Laughing Under the Clouds: Gaiden Part 2", "MOVIE", 2018),
	}
	_, _, sc := PickExplain(ParseName("Donten ni Warau Gaiden", "Donten ni Warau Gaiden", ""), list)
	if sc[0].Score != sc[1].Score {
		t.Errorf("Part 2 film scored apart: %+v", sc)
	}
}
