package match

import "testing"

func TestNonVideoFolder(t *testing.T) {
	for name, want := range map[string]bool{
		"Music Videos":  true,
		"Software":      true,
		"Notes":         true,
		"Games 2024":    true,
		"Some Category": false,
		"Anime-Serien":  false,
		"Cowboy Bebop":  false,
	} {
		if got := NonVideoFolder(ParseName(name, GuessTitle(name), GuessAltTitle(name))); got != want {
			t.Errorf("NonVideoFolder(%q) = %v, want %v", name, got, want)
		}
	}
}
