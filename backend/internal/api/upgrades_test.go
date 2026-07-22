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

func TestBestVariant(t *testing.T) {
	vs := []seriesVariant{
		{v: UpgradeVariant{Folder: "a", ResRank: 720, Dub: []string{"Ger"}}},
		{v: UpgradeVariant{Folder: "b", ResRank: 1080, Dub: []string{"Ger"}}},        // wins on res
		{v: UpgradeVariant{Folder: "c", ResRank: 1080, Dub: []string{"Ger", "Jap"}}}, // ties res, wins dub
	}
	if got := bestVariant(vs); got.v.Folder != "c" {
		t.Errorf("bestVariant picked %q want c", got.v.Folder)
	}
}
