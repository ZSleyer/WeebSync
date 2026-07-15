package rename

import "testing"

func TestTemplatePlexUnderscore(t *testing.T) {
	got, err := New("[SubGroup] Frieren - S02E12 [1080p].mkv", Options{
		Mode: "template", Template: "{title} - S{season:02}E{episode:02}", Separator: "_",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "Frieren_-_S02E12.mkv"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestTemplateDefaults(t *testing.T) {
	// no season in the name → season 1; spaces kept without separator
	got, err := New("[Foo] Some Show - 05 (720p).mkv", Options{
		Mode: "template", Template: "{title} - S{season:02}E{episode:02}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Some Show - S01E05.mkv" {
		t.Errorf("got %q", got)
	}
}

func TestTemplateTitleOverride(t *testing.T) {
	got, err := New("[Foo] Shingeki - 01.mkv", Options{
		Mode: "template", Template: "{title} - E{episode:02}", TitleOverride: "Attack on Titan",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Attack on Titan - E01.mkv" {
		t.Errorf("got %q", got)
	}
}

func TestTemplateMissingVar(t *testing.T) {
	if _, err := New("just-a-file.txt", Options{Mode: "template", Template: "{title} E{episode}"}); err == nil {
		t.Error("expected error for missing episode")
	}
}

func TestRegexMode(t *testing.T) {
	got, err := New("Show.S01E02.mkv", Options{
		Mode: "regex", Pattern: `\.S(\d+)E(\d+)\.`, Replacement: " - S${1}E${2}.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Show - S01E02.mkv" {
		t.Errorf("got %q", got)
	}
}

func TestSanitize(t *testing.T) {
	if s := sanitize("a/b\\c:d*e?f\"g<h>i|j"); s != "abcdefghij" {
		t.Errorf("got %q", s)
	}
}
