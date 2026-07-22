package api

import "testing"

func TestLangCode(t *testing.T) {
	cases := map[string]string{
		"ger": "Ger", "deu": "Ger", "de": "Ger",
		"eng": "Eng", "jpn": "Jap", "ja": "Jap",
		"und": "", "": "",
		"xyz": "Xyz", // unknown -> title-cased three letters
	}
	for in, want := range cases {
		if got := langCode(in); got != want {
			t.Errorf("langCode(%q)=%q want %q", in, got, want)
		}
	}
}
