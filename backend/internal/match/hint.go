package match

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// A hint is the last thing offered for a folder in an anime scope that no
// AniList query found: the folder may be western animation or live action,
// which AniList does not list but TMDB does. A hint is only ever a suggestion
// the user confirms, yet a wrong one is still noise on every folder that is
// not a show at all (a container, a category, a pile of music videos), so the
// gate is as strict as the relaxed AniList stage and then some:
//
//   - the whole cleaned folder name is the query, and every word of it must
//     be explained by one of the candidate's titles (RelaxedAccept's rule);
//   - the other way round too: the candidate's title may not have words the
//     folder lacks ("Star Wars" is not "Star Wars Rebels");
//   - a one-word name needs more than its words (see HintTier);
//   - the candidate has a poster or an overview, not an empty stub.

// HintTier says how much a folder's name tags vouch for it being a show.
type HintTier int

const (
	// HintStrict: audio tagged Japanese. Anime is what AniList lists, so a
	// show tagged this way that AniList lacks is more often a misspelling
	// of an AniList title than a western one; it may still get a hint, but
	// no folder word may be missing from the candidate's title.
	HintStrict HintTier = iota
	// HintNormal: no tag says anything.
	HintNormal
	// HintStrong: the audio is English or German only (no Japanese track), or
	// the name carries a streaming service tag. Releases like these are
	// western or live-action shows far more often than anime: they get
	// looked up first, and may be a single word.
	HintStrong
)

// hintMinLetters is the shortest query a hint is searched for; shorter names
// are initials and fragments, not titles.
const hintMinLetters = 7

// hintMinVotes is how many votes any candidate needs: an entry nobody rated
// is a stub someone filed, and shares its name with folders that are no show
// (a notes folder named like a one-episode web special). A one-word name needs
// more, since a single common word names many obscure entries.
const (
	hintMinVotes     = 10
	hintMinVotesWord = 30
)

// hintCategoryWords name a kind of content or a way of filing it. A short
// folder name made of them is a category, never a show.
var hintCategoryWords = map[string]bool{
	"anime": true, "animes": true, "cartoon": true, "cartoons": true, "series": true, "serien": true,
	"show": true, "shows": true, "movie": true, "movies": true, "film": true, "films": true, "filme": true,
	"music": true, "musik": true, "video": true, "videos": true, "clip": true, "clips": true, "software": true,
	"documentary": true, "documentaries": true, "docs": true, "game": true, "games": true, "book": true,
	"books": true, "extras": true, "extra": true, "bonus": true, "misc": true, "other": true, "others": true,
	"various": true, "archive": true, "backup": true, "download": true, "downloads": true, "incoming": true,
	"new": true, "old": true, "temp": true, "tmp": true, "tv": true, "web": true, "rips": true, "rip": true,
	"bd": true, "dvd": true, "collection": true, "collections": true, "complete": true, "season": true,
	"seasons": true, "specials": true, "special": true, "ova": true, "ovas": true, "notes": true, "docu": true,
	"stuff": true, "random": true, "unsorted": true, "sorted": true, "family": true, "kids": true,
	"children": true, "international": true, "english": true, "german": true, "japanese": true,
}

// HintQuery is the search for a folder's hint: its name without tags, season
// and version markers. "" when the name cannot name a show.
func HintQuery(info Info) string {
	if relaxedCollectionRe.MatchString(info.Full) || musicFolderRe.MatchString(info.Full) {
		return ""
	}
	q := strings.Trim(relaxedClean(info.Full), " &+-,.")
	if letterCount(q) < hintMinLetters {
		return ""
	}
	words := gateWords(q)
	if len(words) == 0 {
		return ""
	}
	if len(words) <= 2 {
		cat := 0
		for _, w := range words {
			if hintCategoryWords[w] {
				cat++
			}
		}
		if cat > 0 {
			return ""
		}
	}
	return q
}

// hintWords splits a title into comparison words like gateWords, but keeps
// lone letters: they tell "Dragon Ball" from "Dragon Ball Z".
func hintWords(s string) []string {
	s = strings.NewReplacer("'", "", "’", "").Replace(s)
	return strings.FieldsFunc(Normalize(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// HintAccept reports whether candidate m, found by searching query on TMDB,
// is the folder's show, for a hint. See the package comment above for the rules.
func HintAccept(info Info, query string, m anilist.Media, tier HintTier) bool {
	if info.Season > 1 || info.OVA {
		return false // TMDB keeps one entry per show: a season or a special is not it
	}
	return strictGate(info, query, m, tier, true, false)
}

// HintAcceptFrom is HintAccept for a provider that counts no audience (TVDB):
// the poster or overview has to vouch for the entry instead of its votes.
func HintAcceptFrom(info Info, query string, m anilist.Media, tier HintTier, votes bool) bool {
	if info.Season > 1 || info.OVA {
		return false
	}
	return strictGate(info, query, m, tier, votes, false)
}

// AutoAccept is the gate a candidate from a provider other than the one a
// folder's name points to must pass, in a folder marked "automatic": the same
// title exists as anime and as live action, so what the folder says has to be
// all the candidate's title says. It is HintAccept's gate for folders that
// name a season: markers are stripped from both sides, the season and the year
// of a later season are left to the provider's own season logic. A special
// (OVA) is never taken this way. votes says the provider counts an audience
// (TVDB does not): without it only the poster or overview is required.
func AutoAccept(info Info, query string, m anilist.Media, tier HintTier, votes bool) bool {
	if info.OVA {
		return false
	}
	return strictGate(info, query, m, tier, votes, true)
}

// strictGate is the check behind HintAccept and AutoAccept; seasons says the
// folder may name a later season of the candidate's show.
func strictGate(info Info, query string, m anilist.Media, tier HintTier, votes, seasons bool) bool {
	if query == "" {
		return false
	}
	if m.CoverImage.Large == "" && strings.TrimSpace(m.Description) == "" {
		return false // an empty stub
	}
	// a folder that says Movie is not the series sharing the title
	if info.Movie && m.Format != "MOVIE" {
		return false
	}
	qw := gateWords(query)
	// a one-word name is a hint only when the tags vouch for a show or the
	// folder names its year, and the candidate has an audience
	if len(qw) == 1 && !(tier == HintStrong || info.Year != 0) {
		return false
	}
	if votes && (m.Popularity < hintMinVotes || (len(qw) == 1 && m.Popularity < hintMinVotesWord)) {
		return false
	}
	// the folder's year is the show's first year: a sequel or a remake from
	// another year is a different entry (a later season starts later)
	if info.Year != 0 && !(seasons && info.Season > 1) && (m.SeasonYear < info.Year-1 || m.SeasonYear > info.Year+1) {
		return false
	}
	if !relaxedAccept(info, query, m, tier == HintStrict) {
		return false
	}
	// the query lost the folder's trailing numbers with its markers ("Rocky
	// 2"): a number the candidate's titles do not have names another entry
	have := map[string]bool{}
	for _, t := range []string{m.Title.Romaji, m.Title.English} {
		for _, d := range digitsRe.FindAllString(t, -1) {
			have[strings.TrimLeft(d, "0")] = true
		}
	}
	for _, d := range digitsRe.FindAllString(info.Full, -1) {
		if n := strings.TrimLeft(d, "0"); !have[n] && n != strconv.Itoa(info.Season) {
			return false
		}
	}
	// the candidate's own title must be nothing but what the folder says
	extra := 1
	if tier == HintStrict {
		extra = 0
	}
	for _, t := range []string{m.Title.Romaji, m.Title.English} {
		if seasons {
			t = StripFolderMarkers(t)
		}
		tw := hintWords(t)
		if len(tw) == 0 {
			continue
		}
		ok := make([]bool, len(tw))
		explained(tw, hintWords(query), ok)
		miss := 0
		for _, o := range ok {
			if !o {
				miss++
			}
		}
		allowed := 0
		if len(tw) >= 4 {
			allowed = extra
		}
		if miss <= allowed {
			return true
		}
	}
	return false
}

// NonTitle reports whether a folder name cannot be a title at all: a
// collection or music folder, or nothing but words that name a kind of
// content ("Anime", "Movies", "Music Videos"). Nothing is looked up for it.
// Unlike HintQuery this lets a short or one-word title through, since the
// provider's own match decides those.
func NonTitle(info Info) bool {
	if relaxedCollectionRe.MatchString(info.Full) || musicFolderRe.MatchString(info.Full) {
		return true
	}
	words := gateWords(relaxedClean(info.Full))
	if len(words) == 0 {
		return true
	}
	strong := false
	for _, w := range words {
		if !hintCategoryWords[w] {
			return false
		}
		strong = strong || !weakCategoryWords[w]
	}
	// "New Game" is made of category words and is a title all the same
	return strong
}

// weakCategoryWords are category words that also turn up in titles: a name of
// nothing but these is not taken for a category.
var weakCategoryWords = map[string]bool{
	"new": true, "old": true, "game": true, "games": true, "web": true, "tv": true, "family": true, "kids": true,
	"children": true, "international": true, "english": true, "german": true, "japanese": true, "other": true,
	"others": true, "stuff": true, "random": true, "book": true, "books": true, "temp": true, "tmp": true,
	"sorted": true, "complete": true, "special": true, "extra": true, "bonus": true, "docu": true,
}
