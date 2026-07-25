package api

import (
	"reflect"
	"testing"
)

func TestMissingEpisodes(t *testing.T) {
	// set builds a season-encoded key set from (season, episode) pairs, through
	// the very helper the production code encodes with.
	set := func(pairs ...[2]int) map[int]bool {
		m := map[int]bool{}
		for _, p := range pairs {
			m[epKey(p[0], p[1])] = true
		}
		return m
	}
	// s1 encodes a set of season-1 episode numbers.
	s1 := func(eps ...int) map[int]bool {
		m := map[int]bool{}
		for _, e := range eps {
			m[epKey(1, e)] = true
		}
		return m
	}
	cases := []struct {
		name string
		nums map[int]bool
		want []int
	}{
		{"gap in middle", s1(1, 2, 3, 5), []int{4}},
		{"multiple gaps", s1(1, 4, 6), []int{2, 3, 5}},
		{"no gaps", s1(1, 2, 3), nil},
		{"empty", set(), nil},
		{"single episode", s1(5), nil},
		{"offset span", s1(31, 32, 34), []int{33}},
		{"partial start not counted", s1(5, 6, 7), nil}, // 1-4 absent = partial start, not a gap
		// aired-mapping: season-encoded keys. Gaps stay per season - the
		// cross-season range (S21E138 -> S22E01) is NOT a gap.
		{"multi-season no cross gap", set([2]int{21, 135}, [2]int{21, 136}, [2]int{21, 138}, [2]int{22, 1}, [2]int{22, 2}, [2]int{23, 1}), []int{137}},
		{"multi-season gap each", set([2]int{1, 1}, [2]int{1, 3}, [2]int{2, 5}, [2]int{2, 7}), []int{2, 6}},
		// season 0 = specials (sparse numbering), never reported as gaps.
		{"specials ignored", set([2]int{0, 57}, [2]int{0, 59}, [2]int{0, 60}), nil},
	}
	for _, c := range cases {
		got := missingEpisodes(c.nums)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: missingEpisodes(%v) = %v, want %v", c.name, c.nums, got, c.want)
		}
	}
}

// A stray "S01E1208" - an absolute number left in the episode field - used to
// collide with S02E208 under a stride of 1000, handing season 2 a span of
// 1..208 and reporting 181 gaps for a season that was complete. That is exactly
// what Detective Conan looked like in production.
func TestEpKeyDoesNotCollideAcrossSeasons(t *testing.T) {
	if epKey(1, 1208) == epKey(2, 208) {
		t.Fatalf("S01E1208 and S02E208 share key %d", epKey(1, 1208))
	}
	for _, c := range [][2]int{{1, 1208}, {2, 208}, {34, 999}, {0, 12}} {
		se, ep := splitEpKey(epKey(c[0], c[1]))
		if se != c[0] || ep != c[1] {
			t.Errorf("S%02dE%d round-tripped to S%02dE%d", c[0], c[1], se, ep)
		}
	}
	// and an out-of-range number must never reach the map in the first place,
	// or it would give its own season a span reaching up to 1208
	if maxEpisode >= 1000 {
		t.Errorf("maxEpisode = %d lets an absolute number pass as an episode", maxEpisode)
	}
}
