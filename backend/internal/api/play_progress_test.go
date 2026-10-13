package api

import "testing"

func TestEpisodeOf(t *testing.T) {
	cases := map[string]int{
		"Frieren - S02E07.mkv":                            7,
		"The Apothecary Diaries - S03E01v2.mkv":           1,
		"[Group] Frieren - 07 [1080p].mkv":                7,
		"BanG Dream! YUME∞MITA E03v2 [1080p][JapDub].mkv": 3,
		"Opening.mkv": 0,
		"Clevatess II E10 [1080p][AAC][GerJapDub][Web-DL].mkv": 10,
	}
	for name, want := range cases {
		if got := episodeOf(name); got != want {
			t.Errorf("episodeOf(%q) = %d, want %d", name, got, want)
		}
	}
}
