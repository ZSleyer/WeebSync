package api

import "testing"

func TestChapterKind(t *testing.T) {
	for _, c := range []struct {
		title string
		len   float64
		want  string
	}{
		{"Opening", 90, "op"},
		{"OP", 90, "op"},
		{"OP1", 90, "op"},
		{"Intro", 85, "op"},
		{"Opening Song: Gurenge", 89, "op"},
		{"Ending", 90, "ed"},
		{"ED2", 90, "ed"},
		{"Ending Credits", 100, "ed"},
		{"Abspann", 90, "ed"},
		{"オープニング", 90, "op"},
		{"Prologue", 90, ""},
		{"Opened Gate", 90, ""},
		{"Part A", 600, ""},
		{"Preview", 15, ""},
		{"Opening", 20 * 60, ""},
		{"", 90, ""},
	} {
		if got := chapterKind(c.title, c.len); got != c.want {
			t.Errorf("chapterKind(%q, %v) = %q, want %q", c.title, c.len, got, c.want)
		}
	}
}

func TestPlayChapters(t *testing.T) {
	ch := func(start, end, title string) probedChapter {
		c := probedChapter{StartTime: start, EndTime: end}
		c.Tags.Title = title
		return c
	}
	got := playChapters([]probedChapter{
		ch("90.000000", "180.000000", "Opening"),
		ch("0.000000", "90.000000", "Prologue"),
		ch("x", "200", "broken"),
		ch("300", "300", "empty"),
		ch("180.000000", "1300.000000", " Part A "),
	})
	if len(got) != 3 {
		t.Fatalf("got %d chapters, want 3: %+v", len(got), got)
	}
	if got[0].Title != "Prologue" || got[1].Kind != "op" || got[2].Title != "Part A" || got[2].Start != 180 {
		t.Errorf("unexpected chapters: %+v", got)
	}
	if one := playChapters([]probedChapter{ch("0", "1400", "Chapter 1")}); len(one) != 0 {
		t.Errorf("a single chapter should be dropped, got %+v", one)
	}
}
