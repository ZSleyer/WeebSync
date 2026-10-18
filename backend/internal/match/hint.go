package match

import (
	"strings"

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

// HintAccept reports whether candidate m, found by searching query on TMDB,
// is the folder's show, for a hint. See the package comment above for the rules.
func HintAccept(info Info, query string, m anilist.Media, tier HintTier) bool {
	if m.CoverImage.Large == "" && strings.TrimSpace(m.Description) == "" {
		return false // an empty stub
	}
	if info.Season > 1 || info.OVA {
		return false // TMDB keeps one entry per show: a season or a special is not it
	}
	qw := gateWords(query)
	// a one-word name is a hint only when the tags vouch for a show or the
	// folder names its year, and the candidate has an audience
	if len(qw) == 1 && !(tier == HintStrong || info.Year != 0) {
		return false
	}
	if m.Popularity < hintMinVotes || (len(qw) == 1 && m.Popularity < hintMinVotesWord) {
		return false
	}
	// the folder's year is the show's first year: a sequel or a remake from
	// another year is a different entry
	if info.Year != 0 && (m.SeasonYear < info.Year-1 || m.SeasonYear > info.Year+1) {
		return false
	}
	if !relaxedAccept(info, query, m, tier == HintStrict) {
		return false
	}
	// the candidate's own title must be nothing but what the folder says
	extra := 1
	if tier == HintStrict {
		extra = 0
	}
	for _, t := range []string{m.Title.Romaji, m.Title.English} {
		tw := gateWords(t)
		if len(tw) == 0 {
			continue
		}
		ok := make([]bool, len(tw))
		explained(tw, qw, ok)
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
