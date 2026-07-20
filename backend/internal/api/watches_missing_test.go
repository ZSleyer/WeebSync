package api

import (
	"reflect"
	"testing"
)

func TestMissingEpisodes(t *testing.T) {
	set := func(nums ...int) map[int]bool {
		m := map[int]bool{}
		for _, n := range nums {
			m[n] = true
		}
		return m
	}
	// s1 encodes a set of season-1 episode numbers (season*1000+ep).
	s1 := func(eps ...int) map[int]bool {
		m := map[int]bool{}
		for _, e := range eps {
			m[1000+e] = true
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
		// aired-mapping: season-encoded keys (season*1000+ep). Gaps stay per
		// season - the cross-season range (S21E138 -> S22E01) is NOT a gap.
		{"multi-season no cross gap", set(21135, 21136, 21138, 22001, 22002, 23001), []int{137}},
		{"multi-season gap each", set(1001, 1003, 2005, 2007), []int{2, 6}},
		// season 0 = specials (sparse numbering), never reported as gaps.
		{"specials ignored", set(57, 59, 60), nil},
	}
	for _, c := range cases {
		got := missingEpisodes(c.nums)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: missingEpisodes(%v) = %v, want %v", c.name, c.nums, got, c.want)
		}
	}
}
