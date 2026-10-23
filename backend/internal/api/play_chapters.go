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

// opWords and edWords are the titles releases give the opening and the
// ending, compared lowercased as whole words.
var (
	opWords = map[string]bool{"op": true, "opening": true, "intro": true, "vorspann": true, "オープニング": true}
	edWords = map[string]bool{"ed": true, "ending": true, "outro": true, "credits": true, "abspann": true, "エンディング": true}
)

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
// "Ending Credits", "ED - Song". A whole word decides, so "Opened" or
// "Prologue" stay plain chapters.
func chapterKind(title string, length float64) string {
	if length > maxSkipChapter {
		return ""
	}
	words := strings.FieldsFunc(strings.ToLower(title), func(r rune) bool { return !unicode.IsLetter(r) })
	for _, w := range words {
		switch {
		case opWords[w]:
			return "op"
		case edWords[w]:
			return "ed"
		}
	}
	return ""
}
