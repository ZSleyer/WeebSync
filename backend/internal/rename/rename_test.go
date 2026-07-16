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

func TestLangTags(t *testing.T) {
	cases := []struct{ name, dub, sub string }{
		{"Some Show E01 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", "JapDub", "GerEngSub"},
		{"Some Show - 03 (720p) [GerDub,GerSub,XY].mkv", "GerDub", "GerSub"},
		{"Some Show S02E04 [GerJapDub][x265][720p].mkv", "GerJapDub", ""},
		{"[FakeSubs] Some Show - 05 [1080p].mkv", "", ""},
	}
	for _, c := range cases {
		dub, sub := langTags(c.name)
		if dub != c.dub || sub != c.sub {
			t.Errorf("%q: got dub=%q sub=%q, want %q %q", c.name, dub, sub, c.dub, c.sub)
		}
	}
}

func TestCleanGroup(t *testing.T) {
	cases := []struct{ in, want string }{
		{"JapDub", ""},             // language tag, not a group
		{"GerJapDub", ""},          // composed language tag
		{"GerDub,GerSub,XY", "XY"}, // language tags stripped, tag rest kept
		{"FakeSubs", "FakeSubs"},   // real-looking group survives
		{"1080p", ""},              // resolution
		{"Web-DL", ""},             // tech term
		{"x265", ""},               // codec
	}
	for _, c := range cases {
		if got := cleanGroup(c.in); got != c.want {
			t.Errorf("cleanGroup(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTemplateLangAndQuality(t *testing.T) {
	got, err := New("Some Show E01 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv", Options{
		Mode: "template", Template: "{title} - S{season:02}E{episode:02} [{dub}][{sub}][{resolution}]",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Some Show - S01E01 [JapDub][GerEngSub][1080p].mkv" {
		t.Errorf("got %q", got)
	}
	// language tag must never leak into {group}
	if _, err := New("Some Show E01 [JapDub][GerEngSub].mkv", Options{
		Mode: "template", Template: "[{group}] {title}",
	}); err == nil {
		t.Error("expected missing-group error, language tag treated as group")
	}
}

func TestSanitize(t *testing.T) {
	if s := sanitize("a/b\\c:d*e?f\"g<h>i|j"); s != "abcdefghij" {
		t.Errorf("got %q", s)
	}
}
