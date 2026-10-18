// Package match scores AniList search results against a release folder name
// so the catalog matcher can pick the right season/movie entry instead of
// blindly taking the first hit. Pure functions only: no DB, no HTTP.
package match

import (
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/relname"
	"golang.org/x/text/unicode/norm"
)

// Info is what a folder name tells us about the release it holds.
type Info struct {
	Title  string // searchable title (GuessTitle)
	Full   string // folder name minus bracket tags and paren groups
	Alt    string // alternative title from parens (GuessAltTitle)
	Season int    // 0 = no season marker
	Movie  bool
	OVA    bool
	Final  bool // folder names a final season ("Fruits Basket S3 The Final")
	Year   int
}

var (
	bracketRe = regexp.MustCompile(`\[[^\]]*\]`)
	parenRe   = regexp.MustCompile(`\([^)]*\)`)
)

// GuessTitle extracts a searchable series title from a release folder/file
// name. relname handles release-style filenames; folder names in the wild
// look like "Romaji Titel (English Title) [GerDub,CR]", where the bracket
// tags and the alternative title in parens ruin the search, so both are
// stripped afterwards.
func GuessTitle(name string) string {
	// Plex libraries spell spaces as underscores; as one token the title
	// shares nothing with the entry ("7th_Time_Loop")
	name = dropAfterTags(strings.ReplaceAll(name, "_", " "))
	t := relname.Read(name).Title
	if t == "" {
		t = name
	}
	t = bracketRe.ReplaceAllString(t, " ")
	t = parenRe.ReplaceAllString(t, " ")
	if t = strings.Join(strings.Fields(t), " "); t != "" {
		return t
	}
	return strings.TrimSpace(name)
}

// dropAfterTags cuts a free word after the last tag group of a name that
// starts with its title: "Mewkledreamy [JapDub,EngSub] dropped" is the show
// Mewkledreamy, with a note. Text with a digit, a bracket, a format or season
// word stays: it is part of the name.
func dropAfterTags(name string) string {
	end := strings.LastIndex(name, "]")
	if end < 0 || strings.HasPrefix(strings.TrimSpace(name), "[") {
		return name
	}
	tail := strings.TrimSpace(name[end+1:])
	if tail == "" || !tailWordsRe.MatchString(tail) || tailMarkRe.MatchString(tail) {
		return name
	}
	if strings.TrimSpace(bracketRe.ReplaceAllString(name[:end+1], " ")) == "" {
		return name
	}
	return name[:end+1]
}

// GuessAltTitle returns the alternative title from a parenthesized group
// ("Romaji (English) [Tags]" → "English"), used as a search fallback.
func GuessAltTitle(name string) string {
	for _, m := range parenRe.FindAllString(bracketRe.ReplaceAllString(name, " "), -1) {
		alt := strings.Trim(m, "() ")
		if len(strings.Fields(alt)) >= 2 { // "(2022)", "(Ko)" are no titles
			return alt
		}
	}
	return ""
}

// Season/format markers, shared between folder names and AniList titles.
var (
	sSeasonRe    = regexp.MustCompile(`(?i)\bS(\d{1,2})\b`)
	ordSeasonRe  = regexp.MustCompile(`(?i)\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b`)
	wordSeasonRe = regexp.MustCompile(`(?i)\bSeason\s*(\d{1,2})\b`)
	spelledOrdRe = regexp.MustCompile(`(?i)\b(second|third|fourth|fifth)\s+(?:season|act)\b`)
	romanTailRe  = regexp.MustCompile(`\b(II|III|IV|V)\s*$`)
	romanAnyRe   = regexp.MustCompile(`\b(?:II|III|IV|V)\b`)
	numTailRe    = regexp.MustCompile(`\s(\d{1,2})$`)
	finalRe      = regexp.MustCompile(`(?i)\bfinal\s+season\b`)
	folderFinal  = regexp.MustCompile(`(?i)\bfinal\b`)
	movieRe      = regexp.MustCompile(`(?i)\bmovies?\b`)
	ovaRe        = regexp.MustCompile(`(?i)\b(?:ova|oad|specials?)\b`)
	// a free word after the last tag group: "Title [JapDub,EngSub] dropped"
	tailWordsRe = regexp.MustCompile(`^\p{L}[\p{L} '-]*$`)
	tailMarkRe  = regexp.MustCompile(`(?i)\b(?:movies?|films?|ova|oad|specials?|seasons?|staffel|part|final|arc|tv)\b`)
	promoRe     = regexp.MustCompile(`(?i)\b(?:teaser|trailer|pv|cm)\b`)
	yearRe      = regexp.MustCompile(`\b(19|20)\d{2}\b`)
	// the "(2020)" a library names its folders with; a year in the title
	// ("Wonder Woman 1984 (2020)") is part of the title
	parenYearRe = regexp.MustCompile(`\(((?:19|20)\d{2})\)`)
)

var romanNum = map[string]int{"II": 2, "III": 3, "IV": 4, "V": 5}
var spelledNum = map[string]int{"second": 2, "third": 3, "fourth": 4, "fifth": 5}

// seasonMarker reads an explicit season marker from a folder-name fragment.
func seasonMarker(s string) int {
	for _, re := range []*regexp.Regexp{sSeasonRe, ordSeasonRe, wordSeasonRe} {
		if m := re.FindStringSubmatch(s); m != nil {
			n, _ := strconv.Atoi(m[1])
			return n
		}
	}
	if m := spelledOrdRe.FindStringSubmatch(s); m != nil {
		return spelledNum[strings.ToLower(m[1])]
	}
	if m := romanTailRe.FindStringSubmatch(s); m != nil {
		return romanNum[m[1]]
	}
	return 0
}

// Mark is a marker ParseName reads, with its byte span in the name.
type Mark struct {
	Kind  string // season | final | movie | ova | year
	Value string // the season number or year, else the matched text
	Start int
	End   int
}

// Marks finds the season, format and year markers in a name with their
// positions, from the same patterns ParseName reads. For the name tester:
// what it highlights is what matching saw.
func Marks(name string) []Mark {
	var out []Mark
	add := func(kind string, re *regexp.Regexp, value func(sub []string) string) {
		for _, ix := range re.FindAllStringSubmatchIndex(name, -1) {
			sub := make([]string, len(ix)/2)
			for k := range sub {
				if ix[2*k] >= 0 {
					sub[k] = name[ix[2*k]:ix[2*k+1]]
				}
			}
			out = append(out, Mark{Kind: kind, Value: value(sub), Start: ix[0], End: ix[1]})
		}
	}
	num := func(sub []string) string { n, _ := strconv.Atoi(sub[1]); return strconv.Itoa(n) }
	add("season", sSeasonRe, num)
	add("season", ordSeasonRe, num)
	add("season", wordSeasonRe, num)
	add("season", spelledOrdRe, func(sub []string) string { return strconv.Itoa(spelledNum[strings.ToLower(sub[1])]) })
	add("season", romanTailRe, func(sub []string) string { return strconv.Itoa(romanNum[sub[1]]) })
	add("final", folderFinal, func(sub []string) string { return sub[0] })
	add("movie", movieRe, func(sub []string) string { return sub[0] })
	add("ova", ovaRe, func(sub []string) string { return sub[0] })
	for _, ix := range yearRe.FindAllStringIndex(name, -1) {
		y, _ := strconv.Atoi(name[ix[0]:ix[1]])
		if releaseYear(y) != 0 && !yearIsTitleNumber(name, ix[1]) {
			out = append(out, Mark{Kind: "year", Value: name[ix[0]:ix[1]], Start: ix[0], End: ix[1]})
		}
	}
	return out
}

// releaseYear is y when it can be the year a release aired, else 0. A number
// beyond next year is part of a title ("Night Head 2041", "Maou 2099",
// "Koukaku Kidoutai SAC_2045"), and the year veto would kill its real entry.
func releaseYear(y int) int {
	if y > time.Now().Year()+1 {
		return 0
	}
	return y
}

// yearIsTitleNumber reports whether the number ending at byte end of name is
// part of a title rather than a year: "Maji Love 2000%".
func yearIsTitleNumber(name string, end int) bool {
	return end < len(name) && name[end] == '%'
}

// YearVeto reports whether the folder's year rules the candidate out: it aired
// more than two years away, and its own titles do not carry the folder's year
// as a number ("Tokyo 2020" is the entry named so, whenever it aired).
func YearVeto(info Info, m anilist.Media) bool {
	if info.Year == 0 || m.SeasonYear == 0 || abs(m.SeasonYear-info.Year) <= 2 {
		return false
	}
	y := strconv.Itoa(info.Year)
	for _, t := range []string{m.Title.Romaji, m.Title.English} {
		for _, w := range strings.Fields(Normalize(t)) {
			if w == y {
				return false
			}
		}
	}
	return true
}

// ParseName extracts matching hints from a raw folder name plus the already
// guessed titles. Bare trailing digits are deliberately NOT read as a season
// ("Yami Shibai 10" is a title - exact-title scoring handles those).
func ParseName(name, title, alt string) Info {
	name = dropAfterTags(strings.ReplaceAll(name, "_", " "))
	info := Info{Title: title, Alt: alt}
	full := bracketRe.ReplaceAllString(name, " ")
	full = parenRe.ReplaceAllString(full, " ")
	if full = strings.Join(strings.Fields(full), " "); full == "" {
		full = strings.TrimSpace(name)
	}
	info.Full = full

	parsed := relname.Read(name)
	info.Season = parsed.Season
	typeOVA := false
	for _, t := range parsed.Kinds {
		if movieRe.MatchString(t) {
			info.Movie = true
		}
		if ovaRe.MatchString(t) {
			typeOVA = true
		}
	}
	if m := parenYearRe.FindAllStringSubmatch(name, -1); m != nil {
		info.Year, _ = strconv.Atoi(m[len(m)-1][1])
	} else if y := releaseYear(parsed.Year); y != 0 {
		info.Year = y
	} else {
		for _, ix := range yearRe.FindAllStringIndex(name, -1) {
			if y, _ := strconv.Atoi(name[ix[0]:ix[1]]); releaseYear(y) != 0 && !yearIsTitleNumber(name, ix[1]) {
				info.Year = y
				break
			}
		}
	}
	if info.Season == 0 {
		info.Season = seasonMarker(full)
	}
	if info.Season == 0 && alt != "" {
		info.Season = seasonMarker(alt)
	}
	info.Movie = info.Movie || movieRe.MatchString(full) || movieRe.MatchString(alt)
	// OVA from the folder itself, or from the name's kind when no season
	// marker contradicts it: "Toriko (Season 1 + Special)" is a season with
	// extras, not an OVA release
	info.OVA = ovaRe.MatchString(full) || (typeOVA && info.Season == 0)
	info.Final = folderFinal.MatchString(full) || folderFinal.MatchString(alt)
	return info
}

// normReplacer folds typographic quotes, separators and chars the diacritic
// fold below does not cover. Hyphens and slashes become spaces so compound
// spellings compare token-wise ("SCHOOL-LIVE!" vs "School Live!").
var normReplacer = strings.NewReplacer(
	"’", "'", "‘", "'", "“", `"`, "”", `"`,
	";", " ", ":", " ", "-", " ", "/", " ", "ß", "ss",
)

// Normalize folds case, whitespace, typographic quotes and diacritics so
// folder-name variants of a title compare equal to the AniList spelling
// ("Chäos;Child" → "chaos child", "Akiba’s Trip" → "akiba's trip").
func Normalize(s string) string {
	s = normReplacer.Replace(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue // combining mark left over from decomposition
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// SeasonOf reads the season a candidate entry represents from its titles:
// 0 = no marker (base entry), -1 = a "FINAL SEASON" (never season-matched).
func SeasonOf(m anilist.Media) int {
	titles := []string{m.Title.Romaji, m.Title.English}
	for _, t := range titles {
		if finalRe.MatchString(t) {
			return -1
		}
	}
	for _, t := range titles {
		if strings.Contains(t, "∬") {
			return 2
		}
		for _, re := range []*regexp.Regexp{wordSeasonRe, ordSeasonRe} {
			if sm := re.FindStringSubmatch(t); sm != nil {
				n, _ := strconv.Atoi(sm[1])
				return n
			}
		}
		if sm := spelledOrdRe.FindStringSubmatch(t); sm != nil {
			return spelledNum[strings.ToLower(sm[1])]
		}
		if sm := romanTailRe.FindStringSubmatch(t); sm != nil {
			return romanNum[sm[1]]
		}
	}
	// bare trailing number only on the romaji title ("Boku no Hero Academia
	// 2"); n < 2 would misread titles like "Steins;Gate 0"
	if sm := numTailRe.FindStringSubmatch(strings.TrimSpace(m.Title.Romaji)); sm != nil {
		if n, _ := strconv.Atoi(sm[1]); n >= 2 {
			return n
		}
	}
	return 0
}

// StripMarkers removes season and OVA markers from a title, leaving the base
// series title ("Boku no Hero Academia S3" → "Boku no Hero Academia").
func StripMarkers(s string) string {
	for _, re := range []*regexp.Regexp{sSeasonRe, ordSeasonRe, wordSeasonRe, spelledOrdRe, finalRe, ovaRe} {
		s = re.ReplaceAllString(s, " ")
	}
	s = strings.ReplaceAll(s, "∬", " ")
	s = strings.Join(strings.Fields(s), " ")
	s = romanTailRe.ReplaceAllString(s, "")
	if m := numTailRe.FindStringSubmatch(s); m != nil {
		if n, _ := strconv.Atoi(m[1]); n >= 2 {
			s = s[:len(s)-len(m[0])]
		}
	}
	return strings.TrimSpace(s)
}

// StripSeason removes the markers of ONE known season from a title, leaving
// the show's name for a folder: "Mob Psycho 100 III" with season 3 becomes
// "Mob Psycho 100". Unlike StripMarkers - a comparison fold that drops any
// trailing number - a bare number or roman numeral at the end goes only when
// it is that season, so "Mob Psycho 100" and "Steins;Gate 0" keep theirs.
func StripSeason(s string, season int) string {
	for _, re := range []*regexp.Regexp{sSeasonRe, ordSeasonRe, wordSeasonRe, spelledOrdRe, finalRe} {
		s = re.ReplaceAllString(s, " ")
	}
	s = strings.ReplaceAll(s, "∬", " ")
	s = strings.Join(strings.Fields(s), " ")
	// the numeral may sit mid-title ("Mushoku Tensei III Isekai ..."), so it
	// is looked for anywhere - and only the one that spells this season goes
	s = romanAnyRe.ReplaceAllStringFunc(s, func(m string) string {
		if romanNum[strings.TrimSpace(m)] == season {
			return " "
		}
		return m
	})
	s = strings.Join(strings.Fields(s), " ")
	if m := numTailRe.FindStringSubmatch(s); m != nil {
		if n, _ := strconv.Atoi(m[1]); n == season {
			s = s[:len(s)-len(m[0])]
		}
	}
	return strings.TrimSpace(s)
}

// vowelFold collapses Hepburn long-vowel spelling variants ("Haikyuu" vs
// "Haikyu", "Gakkou" vs "Gakko"). Comparison-only - see foldKey.
var vowelFold = strings.NewReplacer("aa", "a", "ee", "e", "oo", "o", "ou", "o", "uu", "u")

// FoldKey reduces a string to its comparison form: Normalize plus long-vowel
// folding, with punctuation dropped so "Haikyuu!!" and "Haikyu" compare
// equal. Not a search query - Normalize is the query-safe form. Exported so the
// series bundler can key a canonical series by the same fold the matcher uses.
func FoldKey(s string) string {
	return keep(vowelFold.Replace(Normalize(s)))
}

// PlainKey is FoldKey without the long-vowel fold: the comparison form of a
// title that is not romaji. Folding "ou" and "oo" is right for "Youjo Senki",
// wrong for "House of the Dragon" or "The Rookie", and makes "Rooster" and
// "Roster" one.
func PlainKey(s string) string {
	return keep(Normalize(s))
}

// keep drops everything but letters, digits and single spaces.
func keep(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' {
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// tokens returns the unique folded word set of s.
func tokens(s string) map[string]bool {
	set := map[string]bool{}
	for _, t := range strings.Fields(FoldKey(s)) {
		set[t] = true
	}
	return set
}

// dice is the Sørensen–Dice coefficient over the token sets of a and b.
func dice(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inter := 0
	for t := range a {
		if b[t] {
			inter++
		}
	}
	return 2 * float64(inter) / float64(len(a)+len(b))
}

// seasonScore rates a candidate's season marker against the folder's.
func seasonScore(info Info, have int) int {
	if have == -1 && info.Final {
		return 40 // the folder names the final season itself
	}
	if info.Season >= 2 {
		switch {
		case have == info.Season:
			return 40
		case have == 0:
			return -10 // base entry: tolerable, relations may still fix it
		default:
			return -40 // explicitly a different season (or FINAL)
		}
	}
	// season-less (or S1) folder: an explicit later season contradicts it
	if have >= 2 || have == -1 {
		return -40
	}
	return 0
}

var ovaFormats = map[string]bool{"OVA": true, "SPECIAL": true, "ONA": true}

// Signal is one reason a candidate gained or lost points. Code is stable and
// translated by the frontend, Arg carries the detail a sentence needs (the
// season, the year). Points sum to Scored.Score.
type Signal struct {
	Code   string `json:"code"`
	Points int    `json:"points"`
	Arg    string `json:"arg,omitempty"`
}

// Scored is one candidate as Pick saw it. Vetoed candidates aired in another
// era than the folder names and were never scored.
type Scored struct {
	Index   int      `json:"index"`
	Score   int      `json:"score"`
	Vetoed  bool     `json:"vetoed,omitempty"`
	Signals []Signal `json:"signals"`
}

// MinScore is the bar below which Pick is not confident: no shared token at
// all, or one among many.
const MinScore = 20

// Pick returns the index of the best-scoring candidate for info. confident
// is false when the folder explicitly names a sequel season or a movie and
// no candidate plausibly is one - better unmatched than the wrong base entry.
// Ties keep the lowest index (today's first-hit behavior).
func Pick(info Info, list []anilist.Media) (int, bool) {
	i, ok, _ := PickExplain(info, list)
	return i, ok
}

// PickExplain is Pick with its reasons: every candidate with the signals that
// make up its score, in list order.
func PickExplain(info Info, list []anilist.Media) (int, bool, []Scored) {
	if len(list) == 0 {
		return 0, false, nil
	}
	names := []string{FoldKey(info.Full)}
	sets := []map[string]bool{tokens(info.Full)}
	if info.Alt != "" {
		names = append(names, FoldKey(info.Alt))
		sets = append(sets, tokens(info.Alt))
	}
	out := make([]Scored, 0, len(list))
	best, bestScore := 0, -1<<30
	for i, m := range list {
		// a folder that names its year ("Skyscraper (2018)", "One Piece (2022)")
		// is not the entry that aired decades away, however well the title
		// fits: that is how a live-action film got filed under an anime
		if YearVeto(info, m) {
			out = append(out, Scored{Index: i, Vetoed: true, Signals: []Signal{{Code: "year_veto", Arg: strconv.Itoa(m.SeasonYear)}}})
			continue
		}
		cands := []string{
			FoldKey(m.Title.Romaji),
			FoldKey(m.Title.English),
			FoldKey(StripMarkers(m.Title.Romaji)),
			FoldKey(StripMarkers(m.Title.English)),
		}
		sig := []Signal{}
		add := func(code string, pts int, arg string) {
			if pts != 0 {
				sig = append(sig, Signal{Code: code, Points: pts, Arg: arg})
			}
		}
		for _, n := range names {
			// space-blind equality also catches spelling-variant spacing
			// ("YuruYuri" vs "Yuru Yuri", "PERSONA5" vs "Persona 5")
			if n != "" && (n == cands[0] || n == cands[1] ||
				squash(n) == squash(cands[0]) || squash(n) == squash(cands[1])) {
				add("title_fold", 100, "")
				break
			}
		}
		// punctuation-strict equality separates titles that only differ in
		// punctuation ("K-ON!!" is the sequel of "K-ON!")
		strict := false
		for _, t := range []string{m.Title.Romaji, m.Title.English} {
			if t != "" && (Normalize(t) == Normalize(info.Full) || (info.Alt != "" && Normalize(t) == Normalize(info.Alt))) {
				strict = true
				add("title_strict", 15, "")
				break
			}
		}
		var bestDice float64
		for _, set := range sets {
			for _, c := range cands {
				bestDice = max(bestDice, dice(set, tokens(c)))
			}
		}
		add("words", int(bestDice*50), strconv.Itoa(int(bestDice*100)))
		// the folder names the entry with fewer words ("Frieren" for "Sousou
		// no Frieren"): whole-token containment of the folder name in the
		// title, with the folder side substantial enough that a stray word
		// cannot claim it. Only that direction: a folder with MORE words
		// ("Haikyu OVA") must not hand the base entry a bonus over the OVA.
		for _, n := range names {
			if n != "" && (contains(n, cands[0]) || contains(n, cands[1])) {
				add("contained", 25, "")
				break
			}
		}
		// a strictly equal title overrides a season contradiction: the
		// folder "K-On!!" IS the entry titled "K-ON!!"/"K-ON! Season 2"
		have := SeasonOf(m)
		if ss := seasonScore(info, have); ss > 0 || !strict {
			add("season", ss, strconv.Itoa(have))
		}
		if info.Movie {
			switch m.Format {
			case "MOVIE":
				add("movie_format", 30, m.Format)
			case "TV":
				add("movie_format", -20, m.Format)
			}
		}
		if info.OVA && ovaFormats[m.Format] {
			add("ova_format", 25, m.Format)
		}
		if info.Year != 0 && m.SeasonYear != 0 && abs(m.SeasonYear-info.Year) <= 1 {
			add("year", 10, strconv.Itoa(m.SeasonYear))
		}
		// teaser/PV entries carry season markers of the season they announce
		// and must never beat the real thing
		if promoRe.MatchString(m.Title.Romaji) || promoRe.MatchString(m.Title.English) {
			add("promo", -60, "")
		}
		// a music video shares its song's name with whatever it is a song
		// of ("Lucky (feat. UMI)" for the series "Lucky"), and no synced
		// folder ever holds one
		if m.Format == "MUSIC" {
			add("music", -60, m.Format)
		}
		score := 0
		for _, x := range sig {
			score += x.Points
		}
		out = append(out, Scored{Index: i, Score: score, Signals: sig})
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	if bestScore == -1<<30 {
		return 0, false, out // every candidate aired in another era
	}
	// below this nothing about the titles agrees: no shared token at all, or
	// one among many. Before, a first season took whatever the search
	// returned and "Skyscraper" became Detective Conan. The bar stays low
	// because folders are often named in German ("Detektiv Conan") while the
	// entry carries romaji and English, and one shared word is all they have.
	if bestScore < MinScore {
		return best, false, out
	}
	return best, true, out
}

// contains reports whether the folder's fold key is a whole-token run inside
// the title's, the folder side carrying at least two words or six letters -
// "assassins" claiming "assassins pride" is what the year check is for.
func contains(folder, title string) bool {
	if folder == "" || title == "" || folder == title || len(folder) >= len(title) {
		return false
	}
	if !strings.Contains(" "+title+" ", " "+folder+" ") {
		return false
	}
	return strings.Contains(folder, " ") || len(folder) >= 6
}

// squash removes spaces for the space-blind exact comparison.
func squash(s string) string {
	return strings.ReplaceAll(s, " ", "")
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
