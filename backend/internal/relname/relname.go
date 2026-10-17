// Package relname reads the metadata a release file or folder name carries:
// title, season, episode, year, release group, resolution and kind (movie,
// OVA, creditless opening...). It knows the shapes that show up on the
// servers WeebSync syncs from - fansub style "[Group] Title - 01 [1080p]",
// scene style "Title.S01E01.German.1080p.WEB-GROUP", German "Title E01
// [GerDub]" and plain folder names "Title (2016)" - and nothing else: a
// name that fits none of them yields what it can, never an error.
package relname

import (
	"regexp"
	"strconv"
	"strings"
)

// Release is what a name says about itself. Zero values mean "not in the
// name".
type Release struct {
	Title string
	// Season is the season number a marker names (S02, "Season 2",
	// "2nd Season", "Staffel 2"); 0 when there is none.
	Season int
	// HasSeason tells a named season 0 (specials, "S00E04") from none.
	HasSeason bool
	// Episodes holds the episode number as written, leading zeros kept and
	// without any "E", version or part suffix: "01", "1165.5" (a decimal
	// comma becomes a dot). A range ("01-12",
	// "S01E01E02") gives its first and last number.
	Episodes []string
	Year     int
	// Kinds lists the release-type words found (Movie, OVA, Special, NCOP,
	// ...) as written.
	Kinds []string
	// Group is the release group, from a leading "[Group]", a trailing
	// "-GROUP" or a closing "[Group]". Language, resolution and codec tags
	// are never a group.
	Group string
	// Resolution is the first resolution token as written: "1080p",
	// "1920x1080", "4K".
	Resolution string
	// Ext is the media file extension without the dot, as written.
	Ext string

	bracketEp []string
}

// Episode is the first episode number, "" when the name has none.
func (r Release) Episode() string {
	if len(r.Episodes) == 0 {
		return ""
	}
	return r.Episodes[0]
}

var mediaExt = map[string]bool{
	"mkv": true, "mp4": true, "avi": true, "m4v": true, "webm": true, "ts": true,
	"wmv": true, "ogm": true, "flv": true, "mov": true, "mpg": true, "mpeg": true,
}

var (
	resRe     = regexp.MustCompile(`(?i)^(?:\d{3,4}[pi]\+?|\d{3,4}x\d{3,4}p?|[48]k)$`)
	sizeRe    = regexp.MustCompile(`(?i)^(\d{3,4}x\d{3,4})p$`)
	yearRe    = regexp.MustCompile(`^(?:19|20)\d{2}$`)
	numRe     = regexp.MustCompile(`^(\d{1,4}(?:[.,]\d)?)(?:v\d{1,2}(?:\.\d)?)?$`)
	rangeRe   = regexp.MustCompile(`^(\d{1,4})(?:v\d)?[-~&](\d{1,4})(?:v\d)?$`)
	sxeRe     = regexp.MustCompile(`(?i)^S(\d{1,2})[ ._-]?Ep?(\d{1,4}(?:[.,]\d)?)(?:v\d{1,2}|P\d)?(?:-?E?(\d{1,4}))?$`)
	xRe       = regexp.MustCompile(`^(\d{1,2})x(\d{1,3})(?:v\d)?$`)
	seasonRe  = regexp.MustCompile(`(?i)^S(\d{1,2})$`)
	prefEpRe  = regexp.MustCompile(`(?i)^(?:E|EP|EP\.|Episode|Folge)(\d{1,4}(?:[.,]\d)?)(?:v\d{1,2}|P\d)?$`)
	prefRngRe = regexp.MustCompile(`(?i)^(?:E|EP)(\d{1,4})-E?(\d{1,4})$`)
	ordRe     = regexp.MustCompile(`(?i)^(\d{1,2})(?:st|nd|rd|th|\.)?$`)
	crcRe     = regexp.MustCompile(`^[0-9A-Fa-f]{8}$`)
	kindNumRe = regexp.MustCompile(`(?i)^(NCOP|NCED|OP|ED|SP|PV|OVA|OAD|Special)(\d{1,3})$`)
	sxeDashRe = regexp.MustCompile(`(?i)^(S\d{1,2}E\d{1,4}(?:v\d)?)-(.+)$`)
	// tags that are never a release group
	notGroupRe = regexp.MustCompile(`(?i)^(?:\d{3,4}[pi]\+?|\d{3,4}x\d{3,4}|[48]k|(?:19|20)\d{2}|` +
		`(?:(?:ger|eng|jap|jpn|jp|de|en|fr|es|it|ru|pt|kor|chi|multi|dual)[ -]?){0,4}(?:dub|sub|subs|audio)s?|multi-?subs?|dual[ .-]?audio|omu|` +
		`hevc|avc|x26[45]|h\.?26[45]|hi10p?|xvid|divx|aac|ac3|e-?ac-?3|flac|opus|dts|web(?:-?dl|rip)?|bd(?:rip)?|blu-?ray|dvd(?:rip)?|hdtv|sdtv|` +
		`10-?bit|8-?bit|hdr|uncensored|batch|filler|canon|nf|cr|amzn|dsnp|de|en|ger|eng|jap|deutsch|german|english|japanese)$`)
)

var spelledOrd = map[string]int{
	"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
	"sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}

// filmWords are the kinds whose number counts films.
var filmWords = map[string]bool{"movie": true, "movies": true, "gekijouban": true}

// kindWords are release-type words, keyed lower-case.
var kindWords = map[string]bool{
	"tv": true, "ova": true, "ona": true, "oad": true, "oav": true, "movie": true, "movies": true,
	"gekijouban": true, "special": true, "specials": true, "sp": true, "ncop": true, "nced": true,
	"op": true, "ed": true, "opening": true, "ending": true, "pv": true, "preview": true, "trailer": true,
}

type token struct {
	text   string
	inside bool // in brackets or parentheses
	open   byte // '[' or '('
	dash   bool // a "-" right before the bracket: "...-(GROUP)"
}

// Read parses a file or folder base name.
func Read(name string) Release {
	var r Release
	base := name
	if i := strings.LastIndexByte(name, '.'); i > 0 && mediaExt[strings.ToLower(name[i+1:])] {
		r.Ext, base = name[i+1:], name[:i]
	}
	toks := tokenize(strings.TrimSpace(base))

	// the name proper starts after its leading tags: "[Group] (DE) Title"
	start := 0
	for start < len(toks) && toks[start].inside {
		t := toks[start]
		if start == 0 && t.open == '[' && isGroup(t.text) {
			r.Group = t.text
		} else {
			r.bracketNum(t.text)
			for _, sub := range splitTag(t.text) {
				r.tag(sub)
			}
		}
		start++
	}
	if r.Group == "" {
		r.Group = trailingGroup(toks)
	}

	titleEnd := -1 // first token that is no longer title
	stop := func(i int) {
		if titleEnd < 0 {
			titleEnd = i
		}
	}
	// episode sets the episode unless an earlier marker already did
	episode := func(eps []string) {
		if r.Episodes == nil {
			r.Episodes = eps
		}
	}
	// next reads the token after i as an episode number, for "Season 2 15"
	// and "Special 03"
	next := func(i int) bool {
		if i+1 < len(toks) && !toks[i+1].inside {
			if n := episodeNum(toks[i+1].text); n != nil && !isYear(toks[i+1].text) && r.Episodes == nil {
				r.Episodes = n
				return true
			}
		}
		return false
	}
	// weaker episode candidates, used when no marker names one: a number
	// after " - ", a number before it ("Title 16 - Episode Title"), a bare
	// number in the title run, a bracketed "[01]"
	var dashEp, preDash []string
	dashAt, preDashAt := -1, -1
	var bare []int
	hardEnd, yearAt := -1, -1
	for i := start; i < len(toks); i++ {
		t := toks[i]
		w := t.text
		lw := strings.ToLower(w)
		switch {
		case t.inside:
			hadYear := r.Year != 0
			r.bracketNum(w)
			for _, sub := range splitTag(w) {
				r.tag(sub)
			}
			if !hadYear && r.Year != 0 {
				yearAt = i
			}
			// a bracket the title goes on after is part of it: "Title
			// (Ko)! (Alt Title) [tags]"
			if i+1 >= len(toks) || !plainWord(toks[i+1]) {
				stop(i)
			}
		case w == "-" || w == "–":
			// separator: a number right after it is the episode, unless the
			// number counts a season ("- 1 Staffel")
			if i+2 < len(toks) && isSeasonWord(toks[i+2].text) {
				continue
			}
			if i+1 < len(toks) && !toks[i+1].inside && !isYear(toks[i+1].text) {
				if n := episodeNum(toks[i+1].text); n != nil {
					if dashEp == nil {
						dashEp, dashAt = n, i
					}
					i++
					continue
				}
			}
			if i-1 > start && !toks[i-1].inside && preDash == nil && !isYear(toks[i-1].text) && i-1 > yearAt {
				if preDash = episodeNum(toks[i-1].text); preDash != nil {
					preDashAt = i - 1
				}
			}
		case sxeRe.MatchString(w):
			if r.Episodes == nil {
				m := sxeRe.FindStringSubmatch(w)
				r.setSeason(m[1])
				r.Episodes = []string{m[2]}
				if m[3] != "" {
					r.Episodes = append(r.Episodes, m[3])
				}
			}
			stop(i)
		case xRe.MatchString(w):
			if r.Episodes == nil {
				m := xRe.FindStringSubmatch(w)
				r.setSeason(m[1])
				r.Episodes = []string{m[2]}
			}
			stop(i)
		case res(w) != "":
			if r.Resolution == "" {
				r.Resolution = res(w)
			}
			stop(i)
			hard(&hardEnd, i)
		case kindNumRe.MatchString(w):
			// "NCED1", "OVA2", "SP03"
			m := kindNumRe.FindStringSubmatch(w)
			r.Kinds = append(r.Kinds, m[1])
			episode([]string{m[2]})
			stop(i)
		case seasonRe.MatchString(w):
			if !r.HasSeason {
				r.setSeason(w[1:])
			}
			stop(i)
			if next(i) {
				i++
			}
		case isSeasonWord(w) && i+1 < len(toks) && isSmallNum(toks[i+1].text):
			// "Season 2", "Staffel 2"
			if !r.HasSeason {
				r.setSeason(toks[i+1].text)
			}
			stop(i)
			i++
			if next(i) {
				i++
			}
		case (ordRe.MatchString(w) || spelledOrd[lw] > 0) && i+1 < len(toks) && isSeasonWord(toks[i+1].text):
			// "2nd Season", "Second Season", "2. Staffel", "1 Staffel"
			if !r.HasSeason {
				r.setSeason(strconv.Itoa(spelledOrd[lw]))
				if m := ordRe.FindStringSubmatch(w); m != nil {
					r.setSeason(m[1])
				}
			}
			stop(i)
			i++
		case prefRngRe.MatchString(w):
			m := prefRngRe.FindStringSubmatch(w)
			episode([]string{m[1], m[2]})
			stop(i)
		case prefEpRe.MatchString(w):
			episode([]string{prefEpRe.FindStringSubmatch(w)[1]})
			stop(i)
		case (lw == "episode" || lw == "ep" || lw == "ep." || lw == "eps" || lw == "folge") && i+1 < len(toks) && episodeNum(toks[i+1].text) != nil:
			episode(episodeNum(toks[i+1].text))
			stop(i)
			i++
		case kindWords[lw] && (i > start || filmWords[lw]) && kindAt(toks, i):
			// the kind stays part of the title ("Title OVA 01"); only a
			// number after it ends the title
			r.Kinds = append(r.Kinds, w)
			if filmWords[lw] {
				// "Movie 06" numbers the film, not an episode
				if i+1 < len(toks) && episodeNum(toks[i+1].text) != nil {
					i++
				}
				continue
			}
			if i+2 < len(toks) && !toks[i+2].inside && episodeNum(toks[i+1].text) != nil && episodeNum(toks[i+2].text) != nil {
				i++ // "TV 7 23": season, then episode
			}
			if next(i) {
				stop(i + 1)
				i++
			}
		case (lw == "vol" || lw == "vol." || lw == "volume") && i+1 < len(toks) && episodeNum(toks[i+1].text) != nil:
			stop(i)
			i++
		case isTech(w) && i > start:
			// codec, source and language words end the title, and a number
			// after them is a channel count ("DTS 5.1"), not an episode
			stop(i)
			hard(&hardEnd, i)
		case isYear(w) && i > start && !markerAfter(toks, i):
			// a year in the free text is the release year, unless an episode
			// marker follows - then it belongs to the title ("Hunter x Hunter
			// 2011 - 138")
			if r.Year == 0 {
				r.Year, _ = strconv.Atoi(w)
				yearAt = i
			}
			stop(i)
		case episodeNum(w) != nil:
			bare = append(bare, i)
		}
	}
	// no marked episode in a file name: the last bare number before the
	// release tags, unless it is the title's first word ("86 Eighty Six") or
	// comes before a year, which makes it part of a film title ("Part 2
	// (2004)"). In a folder name a bare number is title ("Title 2199").
	if r.Episodes == nil && dashEp == nil && preDash == nil && r.Ext != "" {
		for j := len(bare) - 1; j >= 0; j-- {
			i := bare[j]
			if hardEnd >= 0 && i > hardEnd {
				continue
			}
			if i > start && i > yearAt {
				r.Episodes = episodeNum(toks[i].text)
				if titleEnd < 0 || i < titleEnd {
					titleEnd = i
				}
			}
			break
		}
		// "Title Ger Sub 190": a whole number after the tech words
		if r.Episodes == nil && hardEnd >= 0 {
			for _, i := range bare {
				if i > hardEnd && i > yearAt && !strings.Contains(toks[i].text, ".") {
					r.Episodes = episodeNum(toks[i].text)
					break
				}
			}
		}
	}
	// a number before the film's year is part of its title ("Title 2 -
	// Subtitle (2019)")
	if preDash != nil && r.Year != 0 && yearAt > preDashAt {
		preDash = nil
	}
	// the title ends at a weak candidate only if it becomes the episode:
	// "Title - 100 Years Quest E13" keeps its subtitle
	if r.Episodes == nil && dashEp != nil && (titleEnd < 0 || dashAt < titleEnd) {
		titleEnd = dashAt
	}
	if r.Episodes == nil && dashEp == nil && preDash != nil && (titleEnd < 0 || preDashAt < titleEnd) {
		titleEnd = preDashAt
	}
	for _, c := range [][]string{dashEp, preDash, r.bracketEp} {
		episode(c)
	}
	for i, e := range r.Episodes {
		r.Episodes[i] = strings.Replace(e, ",", ".", 1)
	}
	r.Title = title(toks[start:], titleEnd-start)
	r.bracketEp = nil
	return r
}

func (r *Release) setSeason(s string) {
	r.Season, _ = strconv.Atoi(s)
	r.HasSeason = true
}

// bracketNum keeps a bracket that holds only a number ("[01]", "[07v2]",
// "(10.5)") as the weakest episode guess.
func (r *Release) bracketNum(s string) {
	if m := numRe.FindStringSubmatch(s); m != nil && !isYear(s) && (!strings.ContainsAny(m[1], ".,") || strings.HasSuffix(m[1], "5")) && r.bracketEp == nil {
		r.bracketEp = []string{m[1]}
	}
}

func (r *Release) tag(s string) {
	switch {
	case res(s) != "":
		if r.Resolution == "" {
			r.Resolution = res(s)
		}
	case yearRe.MatchString(s):
		if r.Year == 0 {
			r.Year, _ = strconv.Atoi(s)
		}
	case kindWords[strings.ToLower(s)]:
		r.Kinds = append(r.Kinds, s)
	case seasonRe.MatchString(s):
		// "(S03)", "(S1+S2)": the first season named
		if !r.HasSeason {
			r.setSeason(s[1:])
		}
	case sxeRe.MatchString(s) && r.Episodes == nil:
		m := sxeRe.FindStringSubmatch(s)
		r.setSeason(m[1])
		r.Episodes = []string{m[2]}
	}
}

// res returns the resolution a word is or holds between dashes ("1080p",
// "Bluray-1080p", "1080p-10bit"), "" for none.
func res(w string) string {
	for _, p := range strings.Split(w, "-") { // "Bluray-1080p", "1080p-10bit"
		if resRe.MatchString(p) {
			if m := sizeRe.FindStringSubmatch(p); m != nil {
				return m[1] // "1440x1080p" is a frame size
			}
			return strings.TrimSuffix(p, "+")
		}
	}
	return ""
}

// splitTag breaks a tag body into its parts: "1080p,AAC", "BD 720p",
// "360p_25fps_H264".
func splitTag(s string) []string {
	dots := !strings.Contains(s, " ") && strings.Count(s, ".") >= 2
	return strings.FieldsFunc(s, func(c rune) bool {
		return c == ',' || c == ' ' || c == '+' || c == '_' || dots && c == '.'
	})
}

func isYear(s string) bool { return yearRe.MatchString(s) }

// isTech reports a codec, source or language word ("x264", "BluRay",
// "German", "DL"); short words like "de" stay title words.
func isTech(s string) bool {
	return strings.EqualFold(s, "DL") || len(s) > 2 && notGroupRe.MatchString(s) && !isYear(s) && res(s) == ""
}

func hard(end *int, i int) {
	if *end < 0 {
		*end = i
	}
}

func isSmallNum(s string) bool {
	if s == "" || s[0] < '0' || s[0] > '9' { // Atoi would take a sign
		return false
	}
	n, err := strconv.Atoi(s)
	return err == nil && n > 0 && n < 100
}

func isSeasonWord(s string) bool {
	return strings.EqualFold(s, "season") || strings.EqualFold(s, "staffel")
}

// plainWord reports a free word that carries no meaning of its own - title
// text.
func plainWord(t token) bool {
	w := t.text
	return !t.inside && w != "-" && w != "–" && episodeNum(w) == nil && !sxeRe.MatchString(w) && !xRe.MatchString(w) &&
		!prefEpRe.MatchString(w) && !prefRngRe.MatchString(w) && !seasonRe.MatchString(w) && !isSeasonWord(w) &&
		res(w) == "" && !isTech(w) && !isYear(w) && !kindNumRe.MatchString(w) && !kindWords[strings.ToLower(w)]
}

// kindAt reports whether the kind word at i names the release's kind: it
// closes the name or comes before a number, a marker or the tags. Followed by
// another plain word it is just a title word ("Wacky TV Nanana").
func kindAt(toks []token, i int) bool {
	if i+1 >= len(toks) {
		return true
	}
	n := toks[i+1]
	return n.inside || n.text == "-" || episodeNum(n.text) != nil || sxeRe.MatchString(n.text) ||
		prefEpRe.MatchString(n.text) || seasonRe.MatchString(n.text) || res(n.text) != "" || isTech(n.text) ||
		kindNumRe.MatchString(n.text) || kindWords[strings.ToLower(n.text)] || romanRe.MatchString(n.text) ||
		filmWords[strings.ToLower(toks[i].text)] && i == 0
}

var romanRe = regexp.MustCompile(`^(?:I{1,3}|IV|V|VI{1,3}|IX|X)$`)

// markerAfter reports whether an explicit episode marker follows token i.
func markerAfter(toks []token, i int) bool {
	for _, t := range toks[i+1:] {
		if t.inside {
			continue
		}
		if t.text == "-" || sxeRe.MatchString(t.text) || prefEpRe.MatchString(t.text) || seasonRe.MatchString(t.text) ||
			strings.EqualFold(t.text, "episode") || isSeasonWord(t.text) {
			return true
		}
	}
	return false
}

// episodeNum reads "01", "1165.5", "01v2" and "01-12" as episode numbers.
func episodeNum(s string) []string {
	if m := numRe.FindStringSubmatch(s); m != nil {
		return []string{m[1]}
	}
	if m := rangeRe.FindStringSubmatch(s); m != nil {
		return []string{m[1], m[2]}
	}
	return nil
}

func title(toks []token, end int) string {
	if end < 0 || end > len(toks) {
		end = len(toks)
	}
	var b []string
	for _, t := range toks[:end] {
		if t.inside {
			if t.open == '(' {
				b = append(b, "("+t.text+")")
			} else {
				b = append(b, "["+t.text+"]")
			}
			continue
		}
		b = append(b, t.text)
	}
	// a dash glued to a word stays ("-Whispers of Dawn-"), a separator goes
	s := strings.Trim(strings.Join(b, " "), " _")
	for strings.HasSuffix(s, " -") || strings.HasSuffix(s, " –") || s == "-" {
		s = strings.TrimRight(strings.TrimSuffix(strings.TrimSuffix(s, "-"), "–"), " _")
	}
	return s
}

func isGroup(s string) bool {
	if notGroupRe.MatchString(s) || crcRe.MatchString(s) || sxeRe.MatchString(s) || versionRe.MatchString(s) ||
		strings.Count(s, ".") >= 2 || strings.Trim(s, "0123456789.- ") == "" {
		return false
	}
	// "1080p-FLAC-10bit" is a tag list, not a name
	for _, p := range strings.Split(s, "-") {
		if res(p) != "" {
			return false
		}
	}
	return true
}

var versionRe = regexp.MustCompile(`(?i)^v\d{1,2}$`)

// trailingGroup is the group at the end of a name: "...WEB-GROUP",
// "...-(GROUP)" or "... [GROUP]".
func trailingGroup(toks []token) string {
	for j := len(toks) - 1; j >= 0; j-- {
		t := toks[j]
		if !t.inside {
			i := strings.LastIndexByte(t.text, '-')
			if i < 0 || i == len(t.text)-1 || i == 0 && j == 0 {
				return ""
			}
			if g := t.text[i+1:]; isGroup(g) && !strings.ContainsAny(g, ".") {
				return g
			}
			return ""
		}
		// "-(GROUP)" closing a scene name, or a closing "[GROUP]"
		if isGroup(t.text) && !strings.ContainsAny(t.text, " ,") && (t.dash || t.open == '[') {
			return t.text
		}
		if !crcRe.MatchString(t.text) {
			return ""
		}
	}
	return ""
}

// tokenize splits a name into words and bracket bodies. Dots separate
// words in names without spaces, except inside a decimal ("12.5", "5.1").
func tokenize(s string) []token {
	spaced := false
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[', '(', '{':
			depth++
		case ']', ')', '}':
			depth--
		case ' ':
			if depth == 0 {
				spaced = true
			}
		}
	}
	var toks []token
	var cur strings.Builder
	dash := false
	flush := func() {
		if cur.Len() > 0 {
			w := cur.String()
			if m := sxeDashRe.FindStringSubmatch(w); m != nil {
				// "S01E04-Episode.Title" glued by a dash
				toks = append(toks, token{text: m[1]}, token{text: "-"})
				w = m[2]
			} else if strings.HasSuffix(w, "-") && spaced && prefEpRe.MatchString(strings.TrimSuffix(w, "-")) {
				// "E07- Title"
				toks = append(toks, token{text: strings.TrimSuffix(w, "-")})
				w = "-"
			}
			dash = w == "-"
			toks = append(toks, token{text: w})
			cur.Reset()
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '[' || c == '(' || c == '{':
			closeC := map[byte]byte{'[': ']', '(': ')', '{': '}'}[c]
			j := strings.IndexByte(s[i+1:], closeC)
			if j < 0 {
				cur.WriteByte(c)
				continue
			}
			glued := strings.HasSuffix(cur.String(), "-") // "...x264-(GROUP)"
			flush()
			dash = dash || glued
			body := strings.TrimSpace(s[i+1 : i+1+j])
			if body != "" {
				open := c
				if open == '{' {
					open = '['
				}
				toks = append(toks, token{text: body, inside: true, open: open, dash: dash})
			}
			dash = false
			i += j + 1
		case c == ' ' || c == '_' || c == '+' && i > 0 && isDigit(s[i-1]) && i+1 < len(s) && (s[i+1]|0x20 == 's' || s[i+1]|0x20 == 'e'):
			// "+" only between "S01E17+S01E18", never in "Title + OVA" or "170+1"
			flush()
		case c == '.' && (!spaced || dotted(s, i)):
			if i > 0 && i+1 < len(s) && isDigit(s[i-1]) && isDigit(s[i+1]) && (i+2 >= len(s) || !isDigit(s[i+2])) {
				cur.WriteByte(c)
			} else {
				flush()
			}
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return toks
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// dotted reports whether the word around s[i] is dot-separated ("A.B.C"),
// which a name with spaces sometimes still carries: "Show.S02.E05.Title
// and more".
func dotted(s string, i int) bool {
	a := strings.LastIndexAny(s[:i], " _[](){}") + 1
	b := strings.IndexAny(s[i:], " _[](){}")
	if b < 0 {
		b = len(s)
	} else {
		b += i
	}
	return strings.Count(s[a:b], ".") >= 2 && !abbrevRe.MatchString(s[a:b])
}

// abbrevRe is a dotted abbreviation: "U.S.", "L.A.".
var abbrevRe = regexp.MustCompile(`^(?:\p{L}\.){2,}\p{L}?$`)
