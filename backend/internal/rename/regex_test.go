package rename

import "testing"

func TestRegexResultSanitized(t *testing.T) {
	got, err := New("a.mkv", Options{Mode: "regex", Pattern: `^(.*)$`, Replacement: `../../x/$1`})
	if err != nil || got != "x/a.mkv" {
		t.Errorf("got %q, %v", got, err)
	}
	// an empty result is "" so callers keep the original name
	got, err = New("a.mkv", Options{Mode: "regex", Pattern: `^.*$`, Replacement: `../..`})
	if err != nil || got != "" {
		t.Errorf("empty: got %q, %v", got, err)
	}
}
