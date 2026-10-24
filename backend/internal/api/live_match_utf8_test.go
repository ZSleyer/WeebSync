package api

import (
	"slices"
	"testing"
	"unicode/utf8"
)

// The main-title query cut before "The" must not split a multibyte rune.
func TestLiveQueriesInnerSubtitleMultibyte(t *testing.T) {
	s := sourceTestServer(t)
	qs := s.liveQueries(1, "/s/x", "Café The Legend of Lara (2024)")
	if !slices.ContainsFunc(qs, func(l liveQuery) bool { return l.q == "Café" }) {
		t.Errorf("Café query missing: %v", qs)
	}
	for _, l := range qs {
		if !utf8.ValidString(l.q) {
			t.Errorf("invalid UTF-8 query %q", l.q)
		}
	}
}
