package rename

import "testing"

func TestTemplateNumericTitleKept(t *testing.T) {
	for title, want := range map[string]string{"007": "007.mkv", "+5": "+5.mkv"} {
		got, err := New("Show - 01.mkv", Options{Mode: "template", Template: "{title}", TitleOverride: title})
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v want %q", title, got, err, want)
		}
	}
}
