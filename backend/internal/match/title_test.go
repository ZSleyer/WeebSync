package match

import "testing"

// Free text after the last tag group is a note, not part of the title; text
// that names a format, a season or a number is.
func TestGuessTitleDropsTextAfterTags(t *testing.T) {
	for name, want := range map[string]string{
		"Mewkledreamy [JapDub,EngSub,Yumi] dropped": "Mewkledreamy",
		"Mewkledreamy [JapDub,EngSub,Yumi]":         "Mewkledreamy",
		"Show [GerDub] (English Title)":             "Show",
		"[Group] Show - 01 [1080p]":                 "Show",
		"Show [JapDub,GerSub] Part 2":               "Show Part 2",
	} {
		if got := GuessTitle(name); got != want {
			t.Errorf("GuessTitle(%q) = %q, want %q", name, got, want)
		}
	}
	if info := ParseName("Mewkledreamy [JapDub,EngSub,Yumi] dropped", "Mewkledreamy", ""); info.Full != "Mewkledreamy" {
		t.Errorf("Full keeps the note: %q", info.Full)
	}
}
