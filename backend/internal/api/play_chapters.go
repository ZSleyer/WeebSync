package api

import (
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// PlayChapter is one chapter mark of a video, in seconds of the file.
type PlayChapter struct {
	Start float64 `json:"start" example:"90.1"`
	End   float64 `json:"end" example:"180.2"`
	Title string  `json:"title,omitempty" example:"Opening"`
	// Kind is "op" or "ed" when the title names the opening or the ending,
	// which the player offers to skip; empty for any other chapter
	Kind string `json:"kind,omitempty" enums:"op,ed" example:"op"`
}

// probedChapter is a chapter as ffprobe -show_chapters prints it.
type probedChapter struct {
	StartTime string `json:"start_time"`
	EndTime   string `json:"end_time"`
	Tags      struct {
		Title string `json:"title"`
	} `json:"tags"`
}

// maxSkipChapter is the longest chapter still taken for an opening or ending:
// both run about 90 s, a 20-minute "Opening" is a mislabelled file.
// ponytail: title heuristic only, no audio fingerprinting across episodes;
// files without chapter marks get no skip button.
const maxSkipChapter = 4 * 60

// skipKeywords are the first words releases give the opening and the ending.
var skipKeywords = map[string]string{
	"op": "op", "opening": "op", "intro": "op", "vorspann": "op", "オープニング": "op",
	"ed": "ed", "ending": "ed", "outro": "ed", "credits": "ed", "abspann": "ed", "エンディング": "ed",
}

// skipExtras are the words that may follow the keyword before the title moves
// on to the song's name behind a separator: "Ending Theme Song", "Credits
// Roll". Japanese writes them onto the keyword: "オープニングテーマ".
var skipExtras = map[string]bool{
	"song": true, "theme": true, "credits": true, "sequence": true, "animation": true, "roll": true, "movie": true,
	"テーマ": true, "ソング": true, "テーマソング": true,
}

// titleTokens splits a title into lowercased words (letters, with an
// apostrophe inside a word kept: "ed's" is not "ed"), numbers (digits with
// at most one letter after them: "1a") and single other characters.
// Full-width forms are folded first ("ＯＰ１" is "op1"), any space is a space.
func titleTokens(title string) (toks []string, words []bool) {
	rs := []rune(strings.ToLower(title))
	for i, r := range rs {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			rs[i] = r - 0xFEE0
		case unicode.IsSpace(r):
			rs[i] = ' '
		}
	}
	for i := 0; i < len(rs); {
		r := rs[i]
		j := i + 1
		switch {
		case r == ' ':
			i = j
			continue
		case unicode.IsLetter(r):
			for j < len(rs) && (unicode.IsLetter(rs[j]) ||
				(rs[j] == '\'' || rs[j] == '’') && j+1 < len(rs) && unicode.IsLetter(rs[j+1])) {
				j++
			}
		case unicode.IsDigit(r):
			for j < len(rs) && unicode.IsDigit(rs[j]) {
				j++
			}
			if j < len(rs) && unicode.IsLetter(rs[j]) && (j+1 == len(rs) || !unicode.IsLetter(rs[j+1])) {
				j++
			}
		}
		toks = append(toks, string(rs[i:j]))
		words = append(words, unicode.IsLetter(r))
		i = j
	}
	return toks, words
}

// skipKeyword reads the keyword a title starts with, after any opening
// brackets: the kind and how many tokens it took, or "" when there is none.
func skipKeyword(toks []string, words []bool) (kind string, n int) {
	if len(toks) == 0 || !words[0] {
		return "", 0
	}
	if k, ok := skipKeywords[toks[0]]; ok {
		return k, 1
	}
	if (toks[0] == "end" || toks[0] == "staff") && len(toks) > 1 && toks[1] == "credits" {
		return "ed", 2
	}
	for _, kw := range []string{"オープニング", "エンディング"} {
		if rest, ok := strings.CutPrefix(toks[0], kw); ok && skipExtras[rest] {
			return skipKeywords[kw], 1
		}
	}
	return "", 0
}

// playChapters turns ffprobe's chapters into the player's: marks whose times
// do not parse or that have no length are left out, and a file with a single
// chapter has none worth showing.
func playChapters(raw []probedChapter) []PlayChapter {
	out := []PlayChapter{}
	for _, c := range raw {
		start, err := strconv.ParseFloat(c.StartTime, 64)
		if err != nil || start < 0 {
			continue
		}
		end, err := strconv.ParseFloat(c.EndTime, 64)
		if err != nil || end <= start {
			continue
		}
		title := strings.TrimSpace(c.Tags.Title)
		out = append(out, PlayChapter{Start: start, End: end, Title: title, Kind: chapterKind(title, end-start)})
	}
	if len(out) < 2 {
		return []PlayChapter{}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

// chapterKind names a chapter "op" or "ed" from its title: "Opening", "OP1",
// "Ending Credits", "ED - Song", "【OP】", "オープニングテーマ". The keyword
// leads the title; after it come only numbers and skipExtras until the end
// or any other character, behind which the song's name may follow. A keyword
// further in ("A Happy Ending") or followed by other words ("Intro to
// Magic", "Ed's Story") is an ordinary chapter.
// ponytail: "Ed & Al" or "Intro - The Beginning" still read as ed/op, a
// separator cannot tell a song's name from a story's; the length cap keeps
// such a card to short chapters.
func chapterKind(title string, length float64) string {
	if length > maxSkipChapter {
		return ""
	}
	toks, words := titleTokens(title)
	for len(toks) > 0 && !words[0] && !unicode.IsDigit([]rune(toks[0])[0]) {
		toks, words = toks[1:], words[1:]
	}
	kind, n := skipKeyword(toks, words)
	if kind == "" {
		return ""
	}
	for i := n; i < len(toks); i++ {
		switch {
		case !words[i] && !unicode.IsDigit([]rune(toks[i])[0]):
			return kind
		case words[i] && !skipExtras[toks[i]]:
			return ""
		}
	}
	return kind
}
