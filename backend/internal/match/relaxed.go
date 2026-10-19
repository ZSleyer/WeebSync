package match

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// The relaxed search is the last resort for a folder every earlier query
// found nothing for. AniList's search wants every word of the query in a
// title, so one different spelling ("Dai Hachi Gakari" for "Dai Hakkei",
// "ReZero" for "Re:Zero", "x" for "×") empties the result. RelaxedQueries
// drops or rewrites the part of the name that is most likely to blame, and
// RelaxedAccept decides whether what came back is the folder's show or only
// a sibling that shares a few words. A query that finds a sibling is worse
// than one that finds nothing: the folder stays unmatched for good.

var (
	relaxedCutRe     = regexp.MustCompile(`\s+[-–]\s+|:\s+`)
	relaxedVersionRe = regexp.MustCompile(`(?i)\bS\d{1,2}v\d{1,2}\b|\bTV\s+Version\b|\bmovie\b|\barc\b`)
	relaxedReRe      = regexp.MustCompile(`\bRe([A-Z])`)
	relaxedXRe       = regexp.MustCompile(`(\p{L}) x (\p{L})`)
	// a folder holding several works at once: no single entry stands for it
	relaxedCollectionRe = regexp.MustCompile(`(?i)\b(?:movies|shorts|specials|ovas|oads|collection|complete)\b`)
	digitsRe            = regexp.MustCompile(`\d+`)
)

// relaxedClean removes what makes a folder name differ from the show's title
// without being part of it: season and part markers, a version, "Movie", "Arc".
func relaxedClean(s string) string {
	s = StripFolderMarkers(s)
	s = relaxedVersionRe.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

// RelaxedQueries lists up to max searches to try for a folder in turn, most
// promising first, none equal to one in tried. full is the folder name minus
// its tags and parens (Info.Full). Every query keeps at least two words and
// relaxedMinLetters letters. Folders named for a collection get none.
func RelaxedQueries(full string, tried []string, max int) []string {
	if relaxedCollectionRe.MatchString(full) {
		return nil
	}
	seen := map[string]bool{}
	for _, t := range tried {
		seen[Normalize(t)] = true
	}
	var out []string
	add := func(q string) {
		q = strings.Join(strings.Fields(q), " ")
		// a query that is one word or a handful of letters ("Some Studio",
		// "Dr. Stone", "Misc") names a family or a category, not a show:
		// a folder with no title relation must never reach a match this way
		if k := Normalize(q); len(out) < max && !seen[k] && len(strings.Fields(q)) >= 2 && letterCount(q) >= relaxedMinLetters {
			seen[k] = true
			out = append(out, q)
		}
	}
	rewrite := func(q string) string {
		q = relaxedReRe.ReplaceAllString(q, "Re:$1")
		return relaxedXRe.ReplaceAllString(q, "$1 × $2")
	}
	base := relaxedClean(full)
	if loc := relaxedCutRe.FindStringIndex(base); loc != nil {
		add(rewrite(base[:loc[0]]))
	}
	add(rewrite(base))
	words := strings.Fields(rewrite(base))
	for _, n := range []int{3, 2} {
		// a cut after a particle ("Star Wars The") is a fragment, not a title
		if len(words) > n && !tailParticles[strings.ToLower(words[n-1])] {
			add(strings.Join(words[:n], " "))
		}
	}
	return out
}

const relaxedMinLetters = 8

// tailParticles are words a title does not end on: cutting a folder name
// after one leaves a fragment ("Star Wars The", "Re:Zero kara").
var tailParticles = map[string]bool{
	"the": true, "a": true, "an": true, "of": true, "to": true, "and": true, "in": true, "on": true,
	"for": true, "at": true, "no": true, "wa": true, "ga": true, "wo": true, "o": true, "ni": true,
	"de": true, "kara": true, "mo": true, "he": true,
}

var musicFolderRe = regexp.MustCompile(`(?i)\b(?:music|musicvideos?|ost|soundtrack|song|songs|opening|ending|pv|amv)\b`)

func letterCount(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			n++
		}
	}
	return n
}

// gateWords splits a title into comparison words: folded, punctuation as a
// separator, apostrophes dropped, lone letters ("x", "s") ignored.
func gateWords(s string) []string {
	s = strings.NewReplacer("'", "", "’", "").Replace(s)
	f := strings.FieldsFunc(Normalize(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	out := f[:0]
	for _, w := range f {
		if utf8.RuneCountInString(w) > 1 || unicode.IsDigit([]rune(w)[0]) {
			out = append(out, w)
		}
	}
	return out
}

// sameWord: equal after the long-vowel fold, or one letter apart on words of
// four or more.
func sameWord(a, b string) bool {
	a, b = vowelFold.Replace(a), vowelFold.Replace(b)
	if a == b {
		return true
	}
	return utf8.RuneCountInString(a) >= 4 && utf8.RuneCountInString(b) >= 4 && withinOne(a, b)
}

// withinOne reports an edit distance of at most one.
func withinOne(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	if len(ra) < len(rb) {
		ra, rb = rb, ra
	}
	if len(ra)-len(rb) > 1 {
		return false
	}
	i, j, diff := 0, 0, 0
	for i < len(ra) && j < len(rb) {
		if ra[i] == rb[j] {
			i++
			j++
			continue
		}
		if diff++; diff > 1 {
			return false
		}
		if len(ra) == len(rb) {
			j++
		}
		i++
	}
	return diff+(len(ra)-i) <= 1
}

// explained marks which of the words appear in the title's words, spelled
// the same, one letter apart, or joined/split ("redive" is "re" + "dive").
func explained(words, title []string, ok []bool) {
	for j, w := range words {
		for k, t := range title {
			if sameWord(w, t) {
				ok[j] = true
			}
			if k+1 < len(title) && sameWord(w, t+title[k+1]) {
				ok[j] = true
			}
			if k+2 < len(title) && sameWord(w, t+title[k+1]+title[k+2]) {
				ok[j] = true
			}
		}
		if j+1 < len(words) {
			for _, t := range title {
				if sameWord(words[j]+words[j+1], t) {
					ok[j], ok[j+1] = true, true
				}
			}
		}
	}
}

// sequelWords name a later installment; one of them left unexplained means
// the folder is that installment and the candidate is not.
var sequelWords = map[string]bool{
	"encore": true, "kai": true, "next": true, "new": true, "again": true, "returns": true,
	"plus": true, "special": true, "specials": true, "ova": true, "oad": true, "movie": true,
	"final": true, "film": true, "films": true, "gekijouban": true, "zenpen": true, "kouhen": true,
}

// RelaxedAccept reports whether candidate m is the folder's show, for a
// candidate found by the relaxed search with query. Everything the query
// asked for must be in one of the candidate's titles (romaji, English,
// synonyms), at most one word of a folder title of four words or more (none of a shorter one) may be missing from them
// (none after a " - " or ": " subtitle, none that names a later installment),
// every number in the candidate's titles must be one the folder has, and a
// candidate that is another season than the folder's is out. Score alone
// does not do this: a sibling sharing the first words scores like the show.
func RelaxedAccept(info Info, query string, m anilist.Media) bool {
	return relaxedAccept(info, query, m, false)
}

// relaxedAccept is RelaxedAccept; strict allows no folder word to be missing
// from the candidate's titles, however long the folder name is.
func relaxedAccept(info Info, query string, m anilist.Media, strict bool) bool {
	return relaxedAcceptSeasons(info, query, m, strict, true)
}

// relaxedAcceptSeasons is relaxedAccept; seasons false leaves the season of the
// candidate out of the judgement, for a film whose number is part of its title
// ("Toy Story 2" is no second season of "Toy Story").
func relaxedAcceptSeasons(info Info, query string, m anilist.Media, strict, seasons bool) bool {
	// a folder that names its year cannot be held to an entry that has none
	if info.Year != 0 && m.SeasonYear == 0 {
		return false
	}
	// music videos share their song's name with whatever it is a song of
	if m.Format == "MUSIC" && !musicFolderRe.MatchString(info.Full) {
		return false
	}
	titles := [][]string{gateWords(m.Title.Romaji), gateWords(m.Title.English)}
	for _, syn := range m.Synonyms {
		titles = append(titles, gateWords(syn))
	}
	cover := func(words []string) []bool {
		ok := make([]bool, len(words))
		for _, t := range titles {
			explained(words, t, ok)
		}
		return ok
	}
	qw := gateWords(query)
	if len(qw) == 0 {
		return false
	}
	for _, ok := range cover(qw) {
		if !ok {
			return false
		}
	}
	main, sub := relaxedClean(info.Full), ""
	if loc := relaxedCutRe.FindStringIndex(main); loc != nil {
		main, sub = main[:loc[0]], main[loc[1]:]
	}
	missing := 0
	mw, sw := gateWords(main), gateWords(sub)
	// one word may be missing from a title of four words or more, none from a
	// shorter one: "Star Wars Rebels" is not "Star Wars"
	allowed := 0
	if len(mw)+len(sw) >= 4 && !strict {
		allowed = 1
	}
	for i, ok := range cover(mw) {
		if !ok {
			if missing++; missing > allowed || sequelWords[mw[i]] {
				return false
			}
		}
	}
	for _, ok := range cover(sw) {
		if !ok {
			return false
		}
	}
	have := map[string]bool{strconv.Itoa(info.Season): info.Season > 0}
	for _, d := range digitsRe.FindAllString(info.Full+" "+info.Alt, -1) {
		have[strings.TrimLeft(d, "0")] = true
	}
	for _, t := range []string{m.Title.Romaji, m.Title.English} {
		for _, d := range digitsRe.FindAllString(t, -1) {
			if !have[strings.TrimLeft(d, "0")] {
				return false
			}
		}
	}
	if !seasons {
		return true
	}
	switch so := SeasonOf(m); {
	case so >= 2 && so != info.Season:
		return false
	case so == -1 && !info.Final:
		return false
	}
	return true
}
