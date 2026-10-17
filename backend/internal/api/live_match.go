package api

import (
	"regexp"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/match"
)

// Matching on TVDB and TMDB. Their searches rank by popularity, so the first
// hit was often a spin-off or a stranger that only shares a word: "Squid Game
// (2021)" became the reality show, "The 50" became The Bear. A hit is taken
// only when one of its titles - translations and aliases included - equals a
// name the folder goes by; anything less leaves the folder unmatched, which
// shows, where a wrong match does not.

// liveCand is one search hit with every title it is known by.
type liveCand struct {
	id, year int
	titles   []string
	anime    bool // the anime mapping knows it: breaks a tie for a Japanese folder
}

// liveQuery is one search for a folder: q is sent to the provider, accept is
// the name a hit may carry besides the folder's own ("" for none).
type liveQuery struct{ q, accept string }

// innerSubtitle finds where a subtitle starts that lost its colon in the
// folder name ("The Walking Dead The Ones Who Live", "Tomb Raider The Legend
// of Lara Croft"): an article after the first word.
var innerSubtitle = regexp.MustCompile(`\S (?:The|A|An|Der|Die|Das) `)

// japAudio tells a release of a Japanese show by its audio tag ("[JapDub,
// GerSub]", "[GerJapDub]"), which no live-action release carries.
var japAudio = regexp.MustCompile(`(?i)\[[^\]]*jap`)

// subtitleDash splits a German distribution subtitle off the title ("Slow
// Horses - Ein Fall für Jackson Lamb", "Band of Brothers – Wir waren wie
// Brüder"): the part before it is what TVDB and TMDB know.
var subtitleDash = regexp.MustCompile(` [-–] `)

// trailingYear is the "(2021)" TVDB appends to the name of a remake.
var trailingYear = regexp.MustCompile(`\s*\((?:19|20)\d{2}\)$`)

// releaseTitleRe reads the title off a scene or Plex file name, the part before
// the episode marker ("Lockerbie.A.Search.for.Truth.S01E01.GERMAN…").
var releaseTitleRe = regexp.MustCompile(`(?i)^(.+?)[ ._-]+S\d{1,2}E\d{1,3}`)

// liveQueries lists the names a live-action folder is searched under, best
// first: the guessed title, the title without a German subtitle, the
// alternative in parens, dots read as spaces, and the title its files carry.
func (s *Server) liveQueries(serverID int64, folder, name string) []liveQuery {
	var qs []liveQuery
	seen := []string{}
	addAs := func(q string, accept bool) {
		if q = strings.Join(strings.Fields(q), " "); q != "" && !slices.Contains(seen, q) {
			seen = append(seen, q)
			lq := liveQuery{q: q}
			if accept {
				lq.accept = q
			}
			qs = append(qs, lq)
		}
	}
	add := func(q string) { addAs(q, true) }
	title, alt := GuessTitle(name), GuessAltTitle(name)
	add(title)
	if loc := subtitleDash.FindStringIndex(title); loc != nil {
		add(title[:loc[0]])
	}
	add(alt)
	add(strings.ReplaceAll(title, ".", " "))
	// TVDB and TMDB keep one entry per show: "… 3th Season" is a season of it
	add(match.StripMarkers(title))
	add(match.StripMarkers(alt))
	add(s.releaseTitle(serverID, folder))
	// last, and only to search: it finds the show the subtitle belongs to as
	// well, which the folder does not name - the folder's full name, colon
	// or not, picks the subtitled one among the hits
	if loc := innerSubtitle.FindStringIndex(title); loc != nil {
		addAs(title[:loc[0]+1], false)
	}
	return qs
}

// releaseTitle is the title the first episode file in a folder names, "" when
// the files carry none ("S01E01.(HDTV-720p)-(Sonarr).mkv") or the folder is
// not indexed.
func (s *Server) releaseTitle(serverID int64, folder string) string {
	rows, err := s.DB.Query(`SELECT name FROM remote_index WHERE server_id = ? AND parent = ? AND is_dir = 0 ORDER BY name LIMIT 20`,
		serverID, folder)
	if err != nil {
		return ""
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if rows.Scan(&n) != nil {
			continue
		}
		if m := releaseTitleRe.FindStringSubmatch(n); m != nil {
			return strings.NewReplacer(".", " ", "_", " ").Replace(m[1])
		}
	}
	// a failed read names no title, same as an empty folder
	_ = rows.Err()
	return ""
}

// pickLive returns the id of the hit a folder names under query, 0 when none
// carries one of the folder's names exactly. The year in the folder is a
// strong hint and a veto beyond two years, as for anime, and rules out an
// entry that has none.
func pickLive(name, accept string, cands []liveCand) int {
	info := match.ParseName(name, accept, accept)
	// one entry per show here: "3th Season" names a season of it, not a
	// sequel entry the search should find instead of the show
	info.Season = 0
	var list []anilist.Media
	var anime []bool
	for _, c := range cands {
		// an entry without a year cannot be held to the folder's: on TVDB that
		// is an empty stub ("Best Bet", "Shackleton (1983)"), never the show
		if info.Year != 0 && c.year == 0 {
			continue
		}
		for _, t := range c.titles {
			// TVDB tells shows of one name apart by a year in it ("Around the
			// World in 80 Days (2021)"); the year is the entry's, not the title
			if t = strings.TrimSpace(trailingYear.ReplaceAllString(t, "")); t == "" {
				continue
			}
			var m anilist.Media
			m.ID, m.SeasonYear, m.Format = c.id, c.year, "TV"
			m.Title.Romaji = t
			list = append(list, m)
			anime = append(anime, c.anime)
		}
	}
	idx, ok, scored := match.PickExplain(info, list)
	if !ok || !exactTitle(scored[idx]) {
		return 0
	}
	// two shows the folder names equally well ("One Piece" the anime and the
	// 2023 series, no year to tell them apart): a guess between them is worse
	// than none, unless the release is Japanese and one of them is the anime
	tied, tiedAnime := map[int]bool{}, map[int]bool{}
	for _, sc := range scored {
		if sc.Vetoed || sc.Score != scored[idx].Score {
			continue
		}
		tied[list[sc.Index].ID] = true
		if anime[sc.Index] {
			tiedAnime[list[sc.Index].ID] = true
		}
	}
	if len(tied) == 1 {
		return list[idx].ID
	}
	if japAudio.MatchString(name) && len(tiedAnime) == 1 {
		for id := range tiedAnime {
			return id
		}
	}
	return 0
}

// exactTitle reports whether a candidate carries one of the folder's names.
func exactTitle(sc match.Scored) bool {
	for _, sg := range sc.Signals {
		if sg.Code == "title_fold" {
			return true
		}
	}
	return false
}
