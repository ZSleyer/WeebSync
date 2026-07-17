package rename

import "testing"

func TestEpisodeOffset(t *testing.T) {
	cases := []struct{ name, tmpl, title, want string }{
		{"One Piece E1156 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", "{title} - S23E{episode-1155:02}", "One Piece", "One Piece - S23E01.mkv"},
		{"Meitantei Conan E1178 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", "{title} - S33E{episode-1147:02}", "Detektiv Conan", "Detektiv Conan - S33E31.mkv"},
		{"[Fag] Dr. Stone - 26v2 [AoD][WebBD 1080p+ AAC].mkv", "{title} - S04E{episode-25:02}", "Dr. Stone", "Dr. Stone - S04E01.mkv"},
		{"Clevatess E05 [GerJapDub].mkv", "{title} - S02E{episode:02}", "Clevatess", "Clevatess - S02E05.mkv"},
	}
	for _, c := range cases {
		got, err := New(c.name, Options{Mode: "template", Template: c.tmpl, TitleOverride: c.title})
		if err != nil || got != c.want {
			t.Errorf("New(%q)\n  = %q (err %v)\n want %q", c.name, got, err, c.want)
		}
	}
}
