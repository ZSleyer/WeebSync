package api

import "testing"

func TestStrictSuperset(t *testing.T) {
	cases := []struct {
		a, b []string
		want bool
	}{
		{[]string{"Ger", "Jap"}, []string{"Ger"}, true},  // one more
		{[]string{"Ger"}, []string{"Ger"}, false},        // equal
		{[]string{"Ger"}, []string{"Ger", "Jap"}, false}, // fewer
		{[]string{"Eng", "Jap"}, []string{"Ger"}, false}, // more but not covering
		{[]string{"Ger", "Jap"}, nil, true},              // superset of empty
	}
	for _, c := range cases {
		if got := strictSuperset(c.a, c.b); got != c.want {
			t.Errorf("strictSuperset(%v,%v)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestBestCopy(t *testing.T) {
	vs := []UpgradeVariant{
		{Folder: "a", ResRank: 720, Dub: []string{"Ger"}},
		{Folder: "b", ResRank: 1080, Dub: []string{"Ger"}},        // wins on res
		{Folder: "c", ResRank: 1080, Dub: []string{"Ger", "Jap"}}, // ties res, wins dub
	}
	if got := bestCopy(vs); got.Folder != "c" {
		t.Errorf("bestCopy picked %q want c", got.Folder)
	}
}
