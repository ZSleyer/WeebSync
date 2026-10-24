package rename

import "testing"

func TestTemplateSubtitleSidecars(t *testing.T) {
	o := Options{Mode: "template", Template: "{title} - S{season:02}E{episode:02}"}
	for in, want := range map[string]string{
		"Show - 05.mkv":                  "Show - S01E05.mkv",
		"Show - 05.ass":                  "Show - S01E05.ass",
		"Show - S01E05.ass":              "Show - S01E05.ass",
		"Show - 05.ssa":                  "Show - S01E05.ssa",
		"Show - 05.vtt":                  "Show - S01E05.vtt",
		"Show - 05.ger.srt":              "Show - S01E05.ger.srt",
		"Show - 05.en.forced.srt":        "Show - S01E05.en.forced.srt",
		"Show - 05.pt-BR.ass":            "Show - S01E05.pt-BR.ass",
		"[Grp] Show - 05 [1080p].de.ass": "Show - S01E05.de.ass",
	} {
		got, err := New(in, o)
		if err != nil {
			t.Errorf("%q: %v", in, err)
		} else if got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	// {ext} carries the whole sidecar tail too
	got, err := New("Show - 05.ger.srt", Options{Mode: "template", Template: "{title} E{episode:02}.{ext}"})
	if err != nil || got != "Show E05.ger.srt" {
		t.Errorf("{ext}: got %q, %v", got, err)
	}
}
