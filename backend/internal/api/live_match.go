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
}

// subtitleDash splits a German distribution subtitle off the title ("Slow
// Horses - Ein Fall für Jackson Lamb", "Band of Brothers – Wir waren wie
// Brüder"): the part before it is what TVDB and TMDB know.
var subtitleDash = regexp.MustCompile(` [-–] `)

// releaseTitleRe reads the title off a scene or Plex file name, the part before
// the episode marker ("Lockerbie.A.Search.for.Truth.S01E01.GERMAN…").
var releaseTitleRe = regexp.MustCompile(`(?i)^(.+?)[ ._-]+S\d{1,2}E\d{1,3}`)

// liveQueries lists the names a live-action folder is searched under, best
// first: the guessed title, the title without a German subtitle, the
// alternative in parens, dots read as spaces, and the title its files carry.
func (s *Server) liveQueries(serverID int64, folder, name string) []string {
	var qs []string
	add := func(q string) {
		if q = strings.Join(strings.Fields(q), " "); q != "" && !slices.Contains(qs, q) {
			qs = append(qs, q)
		}
	}
	title := GuessTitle(name)
	add(title)
	if loc := subtitleDash.FindStringIndex(title); loc != nil {
		add(title[:loc[0]])
	}
	add(GuessAltTitle(name))
	add(strings.ReplaceAll(title, ".", " "))
	add(s.releaseTitle(serverID, folder))
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
	return ""
}

// pickLive returns the id of the hit a folder names under query, 0 when none
// carries one of the folder's names exactly. The year in the folder is a
// strong hint and a veto beyond two years, as for anime.
func pickLive(name, query string, cands []liveCand) int {
	info := match.ParseName(name, query, query)
	var list []anilist.Media
	for _, c := range cands {
		for _, t := range c.titles {
			if t == "" {
				continue
			}
			var m anilist.Media
			m.ID, m.SeasonYear, m.Format = c.id, c.year, "TV"
			m.Title.Romaji = t
			list = append(list, m)
		}
	}
	idx, ok, scored := match.PickExplain(info, list)
	if !ok {
		return 0
	}
	exact := false
	for _, sc := range scored {
		// two shows the folder names equally well ("One Piece" the anime and
		// the 2023 series, no year to tell them apart): a guess between them
		// is worse than none
		if sc.Index != idx && !sc.Vetoed && sc.Score == scored[idx].Score && list[sc.Index].ID != list[idx].ID {
			return 0
		}
		if sc.Index == idx {
			for _, sg := range sc.Signals {
				exact = exact || sg.Code == "title_fold"
			}
		}
	}
	if !exact {
		return 0
	}
	return list[idx].ID
}
