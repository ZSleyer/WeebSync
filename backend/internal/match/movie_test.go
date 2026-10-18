package match

import "testing"

func TestStripMovieWord(t *testing.T) {
	for in, want := range map[string]string{
		"Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka - Orion no Ya Movie": "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka - Orion no Ya",
		"Kimi no Na wa movie":  "Kimi no Na wa",
		"Made in Abyss Movies": "Made in Abyss Movies", // a collection, no single entry
		"Movie Star":           "Movie Star",
		"Moviegoers":           "Moviegoers",
	} {
		if got := StripMovieWord(in); got != want {
			t.Errorf("StripMovieWord(%q) = %q, want %q", in, got, want)
		}
	}
}
