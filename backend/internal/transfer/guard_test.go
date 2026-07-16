package transfer

import "testing"

func TestLooksUploading(t *testing.T) {
	gb := int64(1 << 30)
	cases := []struct {
		name     string
		size     int64
		siblings []int64
		want     bool
	}{
		{"200MB next to 1.4GB episodes", 200 << 20, []int64{gb + 400<<20, gb + 400<<20, gb + 380<<20}, true},
		{"compression variance stays", gb + 100<<20, []int64{gb + 400<<20, gb + 400<<20, gb + 380<<20}, false},
		{"too few reference files", 200 << 20, []int64{gb, gb}, false},
		{"first episodes of a season", 4 << 20, []int64{4 << 20, 4 << 20, 4 << 20}, false},
	}
	for _, c := range cases {
		if got := looksUploading(c.size, c.siblings); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
