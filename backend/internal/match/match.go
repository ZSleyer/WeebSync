// Package match scores AniList search results against a release folder name
// so the catalog matcher can pick the right season/movie entry instead of
// blindly taking the first hit. Pure functions only: no DB, no HTTP.
package match

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/nssteinbrenner/anitogo"
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
// name. anitogo handles release-style filenames; folder names in the wild
// look like "Romaji Titel (English Title) [GerDub,CR]", where the bracket
// tags and the alternative title in parens ruin the search, so both are
// stripped afterwards.
func GuessTitle(name string) string {
	parsed := anitogo.Parse(name, anitogo.DefaultOptions)
	t := parsed.AnimeTitle
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
	numTailRe    = regexp.MustCompile(`\s(\d{1,2})$`)
	finalRe      = regexp.MustCompile(`(?i)\bfinal\s+season\b`)
	folderFinal  = regexp.MustCompile(`(?i)\bfinal\b`)
	movieRe      = regexp.MustCompile(`(?i)\bmovies?\b`)
	ovaRe        = regexp.MustCompile(`(?i)\b(?:ova|oad|specials?)\b`)
	promoRe      = regexp.MustCompile(`(?i)\b(?:teaser|trailer|pv|cm)\b`)
	yearRe       = regexp.MustCompile(`\b(19|20)\d{2}\b`)
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

// ParseName extracts matching hints from a raw folder name plus the already
// guessed titles. Bare trailing digits are deliberately NOT read as a season
// ("Yami Shibai 10" is a title - exact-title scoring handles those).
func ParseName(name, title, alt string) Info {
	info := Info{Title: title, Alt: alt}
	full := bracketRe.ReplaceAllString(name, " ")
	full = parenRe.ReplaceAllString(full, " ")
	if full = strings.Join(strings.Fields(full), " "); full == "" {
		full = strings.TrimSpace(name)
	}
	info.Full = full

	parsed := anitogo.Parse(name, anitogo.DefaultOptions)
	if len(parsed.AnimeSeason) > 0 {
		info.Season, _ = strconv.Atoi(parsed.AnimeSeason[0])
	}
	typeOVA := false
	for _, t := range parsed.AnimeType {
		if movieRe.MatchString(t) {
			info.Movie = true
		}
		if ovaRe.MatchString(t) {
			typeOVA = true
		}
	}
	if y, err := strconv.Atoi(parsed.AnimeYear); err == nil {
		info.Year = y
	} else if m := yearRe.FindString(name); m != "" {
		info.Year, _ = strconv.Atoi(m)
	}
	if info.Season == 0 {
		info.Season = seasonMarker(full)
	}
	if info.Season == 0 && alt != "" {
		info.Season = seasonMarker(alt)
	}
	info.Movie = info.Movie || movieRe.MatchString(full) || movieRe.MatchString(alt)
	// OVA from the folder itself, or from anitogo's type when no season
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

// vowelFold collapses Hepburn long-vowel spelling variants ("Haikyuu" vs
// "Haikyu", "Gakkou" vs "Gakko"). Comparison-only - see foldKey.
var vowelFold = strings.NewReplacer("aa", "a", "ee", "e", "oo", "o", "ou", "o", "uu", "u")

// foldKey reduces a string to its comparison form: Normalize plus long-vowel
// folding, with punctuation dropped so "Haikyuu!!" and "Haikyu" compare
// equal. Not a search query - Normalize is the query-safe form.
func foldKey(s string) string {
	s = vowelFold.Replace(Normalize(s))
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
	for _, t := range strings.Fields(foldKey(s)) {
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

// Pick returns the index of the best-scoring candidate for info. confident
// is false when the folder explicitly names a sequel season or a movie and
// no candidate plausibly is one - better unmatched than the wrong base entry.
// Ties keep the lowest index (today's first-hit behavior).
func Pick(info Info, list []anilist.Media) (int, bool) {
	if len(list) == 0 {
		return 0, false
	}
	names := []string{foldKey(info.Full)}
	sets := []map[string]bool{tokens(info.Full)}
	if info.Alt != "" {
		names = append(names, foldKey(info.Alt))
		sets = append(sets, tokens(info.Alt))
	}
	best, bestScore := 0, -1<<30
	for i, m := range list {
		cands := []string{
			foldKey(m.Title.Romaji),
			foldKey(m.Title.English),
			foldKey(StripMarkers(m.Title.Romaji)),
			foldKey(StripMarkers(m.Title.English)),
		}
		score := 0
		for _, n := range names {
			// space-blind equality also catches spelling-variant spacing
			// ("YuruYuri" vs "Yuru Yuri", "PERSONA5" vs "Persona 5")
			if n != "" && (n == cands[0] || n == cands[1] ||
				squash(n) == squash(cands[0]) || squash(n) == squash(cands[1])) {
				score += 100
				break
			}
		}
		// punctuation-strict equality separates titles that only differ in
		// punctuation ("K-ON!!" is the sequel of "K-ON!")
		strict := false
		for _, t := range []string{m.Title.Romaji, m.Title.English} {
			if t != "" && (Normalize(t) == Normalize(info.Full) || (info.Alt != "" && Normalize(t) == Normalize(info.Alt))) {
				strict = true
				score += 15
				break
			}
		}
		var bestDice float64
		for _, set := range sets {
			for _, c := range cands {
				bestDice = max(bestDice, dice(set, tokens(c)))
			}
		}
		score += int(bestDice * 50)
		// a strictly equal title overrides a season contradiction: the
		// folder "K-On!!" IS the entry titled "K-ON!!"/"K-ON! Season 2"
		if ss := seasonScore(info, SeasonOf(m)); ss > 0 || !strict {
			score += ss
		}
		if info.Movie {
			switch m.Format {
			case "MOVIE":
				score += 30
			case "TV":
				score -= 20
			}
		}
		if info.OVA && ovaFormats[m.Format] {
			score += 25
		}
		if info.Year != 0 && m.SeasonYear != 0 && abs(m.SeasonYear-info.Year) <= 1 {
			score += 10
		}
		// teaser/PV entries carry season markers of the season they announce
		// and must never beat the real thing
		if promoRe.MatchString(m.Title.Romaji) || promoRe.MatchString(m.Title.English) {
			score -= 60
		}
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	if bestScore < 35 && (info.Season >= 2 || info.Movie) {
		return best, false
	}
	return best, true
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
