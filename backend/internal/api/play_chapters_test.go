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
		{"opening", 90, "op"},
		{"OPENING", 90, "op"},
		{"Ed", 90, "ed"},
		{"EnDiNg", 90, "ed"},
		{"OP:", 90, "op"},
		{"[ED]", 90, "ed"},
		{"Opening - Gurenge", 90, "op"},
		{"(Intro)", 90, "op"},
		{"Operation", 90, ""},
		{"Edward", 90, ""},
		{"Credited", 90, ""},
		{"Top", 90, ""},
		// a keyword names the chapter only as its first word, followed by
		// nothing, a number, a song/credits word or a separator
		{"Ed's Decision", 90, ""},
		// known ceiling: a separator cannot tell a name from a song (see chapterKind)
		{"Ed & Al", 90, "ed"},
		{"Intro to Magic", 90, ""},
		{"A Happy Ending", 90, ""},
		{"Part A - Opening", 90, ""},
		{"Opening Theme", 90, "op"},
		{"Opening (NCOP)", 90, "op"},
		{"ED | Song Title", 90, "ed"},
		{"オープニング「紅蓮華」", 90, "op"},
		// titles releases use that a stricter match lost before
		{"End Credits", 90, "ed"},
		{"Staff Credits", 90, "ed"},
		{"Credits Roll", 90, "ed"},
		{"ED1 + Preview", 90, "ed"},
		{"Ending & Preview", 90, "ed"},
		{"ED/Preview", 90, "ed"},
		{"ED 2 / Preview", 90, "ed"},
		{"OP/ED", 90, "op"},
		{"Ending Theme Song", 90, "ed"},
		{"Opening theme song", 90, "op"},
		{`OP "Unravel"`, 90, "op"},
		{"Opening 'Song'", 90, "op"},
		{"Opening “Song”", 90, "op"},
		{"Opening «Song»", 90, "op"},
		{"OP #1", 90, "op"},
		{"OP_1", 90, "op"},
		{"Op.", 90, "op"},
		{"Intro.", 90, "op"},
		{"Ending!", 90, "ed"},
		{"OP 1A", 90, "op"},
		{"Opening Animation", 90, "op"},
		{"Ending (Creditless)", 90, "ed"},
		{"Intro (Cold Open)", 90, "op"},
		// full-width forms and the ideographic space
		{"オープニング　「紅蓮華」", 90, "op"},
		{"Op　-　Song", 90, "op"},
		{"OP１", 90, "op"},
		{"End　Credits", 90, "ed"},
		{"Intro　to Magic", 90, ""},
		{"ＯＰ", 90, "op"},
		{"ＥＤ", 90, "ed"},
		{"Ｏｐｅｎｉｎｇ", 90, "op"},
		{"オープニング：「紅蓮華」", 90, "op"},
		{"ED～Song～", 90, "ed"},
		{"ED〜Song〜", 90, "ed"},
		{"ED｜Song", 90, "ed"},
		{"OP （Song）", 90, "op"},
		{"【OP】", 90, "op"},
		{"オープニングテーマ", 90, "op"},
		{"エンディングテーマ", 90, "ed"},
		{"エンディングソング", 90, "ed"},
		{"OPテーマ", 90, "op"},
		{"ED曲", 90, "ed"},
		{"オープニング主題歌", 90, "op"},
		{"オープニング曲「紅蓮華」", 90, "op"},
		{"OP映像", 90, ""},
		// still ordinary chapters
		{"Next Episode Preview", 15, ""},
		{"Eyecatch", 5, ""},
		{"Avant", 90, ""},
		{"NCOP", 90, ""},
		{"   ", 90, ""},
		{"Ed's Story", 90, ""},
		{"Ed’s Story", 90, ""},
		{"Opening Night", 90, ""},
		{"The End Credits Scene", 90, ""},
		{"Opening", 240, "op"},
		{"Opening", 240.001, ""},
		{"Ending", 240, "ed"},
		{"Ending", 240.001, ""},
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

func TestPlayChaptersEdgeCases(t *testing.T) {
	ch := func(start, end, title string) probedChapter {
		c := probedChapter{StartTime: start, EndTime: end}
		c.Tags.Title = title
		return c
	}
	t.Run("negative start is left out", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("-1", "10", "neg"), ch("10", "20", "a"), ch("20", "30", "b")})
		if len(got) != 2 || got[0].Title != "a" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("end equal to start is left out", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("5", "5", "zero"), ch("0", "5", "a"), ch("5", "9", "b")})
		if len(got) != 2 || got[0].Title != "a" || got[1].Title != "b" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("end before start is left out", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("9", "5", "back"), ch("0", "5", "a"), ch("5", "9", "b")})
		if len(got) != 2 {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("unsorted input comes out sorted", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("200", "300", "c"), ch("0", "100", "a"), ch("100", "200", "b")})
		if len(got) != 3 || got[0].Title != "a" || got[1].Title != "b" || got[2].Title != "c" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("one broken of two leaves one valid and so none", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("0", "100", "a"), ch("x", "200", "broken")})
		if got == nil || len(got) != 0 {
			t.Errorf("want empty non-nil slice, got %#v", got)
		}
	})
	t.Run("nil input gives an empty non-nil slice", func(t *testing.T) {
		if got := playChapters(nil); got == nil || len(got) != 0 {
			t.Errorf("got %#v", got)
		}
	})
	t.Run("unparsable end is left out", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("0", "", "a"), ch("0", "5", "b"), ch("5", "9", "c")})
		if len(got) != 2 {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("kind follows the chapter length", func(t *testing.T) {
		got := playChapters([]probedChapter{ch("0", "240", "OP"), ch("240", "480.001", "ED")})
		if len(got) != 2 || got[0].Kind != "op" || got[1].Kind != "" {
			t.Errorf("got %+v", got)
		}
	})
}
