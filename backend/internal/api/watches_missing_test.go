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
	cases := []struct {
		name string
		nums map[int]bool
		want []int
	}{
		{"gap in middle", set(1, 2, 3, 5), []int{4}},
		{"multiple gaps", set(1, 4, 6), []int{2, 3, 5}},
		{"no gaps", set(1, 2, 3), nil},
		{"empty", set(), nil},
		{"single episode", set(5), nil},
		{"offset span", set(31, 32, 34), []int{33}},
		{"partial start not counted", set(5, 6, 7), nil}, // 1-4 absent = partial start, not a gap
	}
	for _, c := range cases {
		got := missingEpisodes(c.nums)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: missingEpisodes(%v) = %v, want %v", c.name, c.nums, got, c.want)
		}
	}
}
