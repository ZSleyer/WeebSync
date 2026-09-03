package api

import (
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ch4d1/weebsync/internal/match"
)

// A unit groups every copy that carries one show_key. The key comes from the
// folder's catalog match, and an automatic match can be wrong: a live-action
// film in a folder the anime matcher was pointed at was filed under whatever
// AniList returned, and the upgrades then offered "Skyscraper (2018)" as the
// better copy of Detective Conan. The matcher is stricter now; what it filed
// earlier is still in the index, so before the copies are compared each remote
// one has to look like the show it is grouped with: its folder name must agree
// with a known title of the series or with a local copy's folder, and a year
// in its name must not be decades off.

var (
	folderYearRe  = regexp.MustCompile(`\b(19|20)\d{2}\b`)
	folderParenRe = regexp.MustCompile(`\(([^)]+)\)`)
	folderTagRe   = regexp.MustCompile(`\[[^\]]*\]|\([^)]*\)`)
	notAlnumRe    = regexp.MustCompile(`[^a-z0-9]+`)
)

// pruneImplausibleRemotes drops remote copies whose folder contradicts the
// unit. Units without a remote, or without any title to judge against, are
// left alone.
func (s *Server) pruneImplausibleRemotes(u catUnits) {
	titles := map[int64][]string{}
	years := map[int64][]int{}
	for _, key := range u.order {
		cu := u.byKey[key]
		if len(cu.remotes) == 0 {
			continue
		}
		known, year := titles[cu.seriesID], years[cu.seriesID]
		if _, ok := titles[cu.seriesID]; !ok && cu.seriesID != 0 {
			known, year = s.seriesTitleSet(cu.seriesID)
			titles[cu.seriesID], years[cu.seriesID] = known, year
		}
		var folded []string
		for _, t := range known {
			folded = append(folded, match.FoldKey(match.StripMarkers(t)))
		}
		for _, l := range cu.locals {
			if strings.HasPrefix(l.Folder, "/") {
				folded = append(folded, folderTitleKeys(l.Folder)...)
			}
		}
		if len(folded) == 0 {
			continue
		}
		kept := cu.remotes[:0]
		for _, r := range cu.remotes {
			if copyAgrees(r.Folder, folded, year) {
				kept = append(kept, r)
			}
		}
		cu.remotes = kept
	}
}

// copyAgrees reports whether a folder could hold the show the titles name. A
// folder that names a year the show never aired in cannot ("Assassins (1995)"
// for a 2019 series, "One Piece (2022)" for the 1999 anime), where the years
// are the show's first and those of its seasons - "Haikyuu To the Top (2020)"
// is a 2014 show's fourth season.
func copyAgrees(folder string, folded []string, years []int) bool {
	base := showFolderBase(folder)
	if y := folderYear(base); y != 0 && len(years) > 0 && !yearFits(y, years) {
		return false
	}
	for _, mine := range folderTitleKeys(folder) {
		for _, theirs := range folded {
			if mine == theirs || titleContains(mine, theirs) || squashed(mine) == squashed(theirs) {
				return true
			}
		}
	}
	return false
}

func yearFits(y int, years []int) bool {
	for _, k := range years {
		if k != 0 && absInt(y-k) <= 2 {
			return true
		}
	}
	return false
}

// squashed drops everything but letters and digits: libraries and release
// groups disagree on where the spaces go ("NieRAutomata Ver 1.1a" against
// "NieR Automata Ver1.1a").
func squashed(s string) string {
	return notAlnumRe.ReplaceAllString(s, "")
}

// titleContains: the known title sits whole inside the folder name ("Alpha"
// in "Alpha 4K": the folder carries the whole title, however short), or the
// folder name sits inside the known title and is substantial - two words, or
// six letters - because "conan" alone would sit inside too many titles.
func titleContains(folder, known string) bool {
	if len(known) >= 4 && strings.Contains(" "+folder+" ", " "+known+" ") {
		return true
	}
	if !strings.Contains(" "+known+" ", " "+folder+" ") {
		return false
	}
	return strings.Contains(folder, " ") || len(folder) >= 6
}

// showFolderBase is the folder segment that names the show: a season folder
// says nothing, its parent does.
func showFolderBase(folder string) string {
	base := path.Base(folder)
	if plexSeasonDirRe.MatchString(base) {
		base = path.Base(path.Dir(folder))
	}
	return base
}

// folderTitleKeys are the fold keys a folder offers: the guessed title, the
// name with every tag and parenthesis cut away, each parenthesised group that
// is not a year ("Yani Neko (Chainsmoker Cat) [tags]" offers the romaji and
// the English name), and the same for the folder above it - an arc folder
// ("16 Elbaph (1156-1200)") is named by the show folder it sits in.
func folderTitleKeys(folder string) []string {
	out := nameKeys(showFolderBase(folder))
	if parent := path.Dir(folder); parent != "/" && parent != "." {
		out = append(out, nameKeys(path.Base(parent))...)
	}
	return out
}

func nameKeys(base string) []string {
	// Plex libraries here spell spaces as underscores (Detektiv_Conan)
	base = strings.ReplaceAll(base, "_", " ")
	cands := []string{match.GuessTitle(base), match.GuessAltTitle(base), folderTagRe.ReplaceAllString(base, " ")}
	for _, m := range folderParenRe.FindAllStringSubmatch(base, -1) {
		if folderYear(m[1]) == 0 {
			cands = append(cands, m[1])
		}
	}
	var out []string
	seen := map[string]bool{}
	for _, t := range cands {
		if k := match.FoldKey(match.StripMarkers(t)); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

func folderYear(base string) int {
	y, _ := strconv.Atoi(folderYearRe.FindString(base))
	return y
}

// seriesTitleSet lists the titles a series is known by (its display titles
// in every locale, and the romaji/English of its AniList TV entries - the
// films and specials a series bundles carry titles of their own, and Conan's
// first film mentions a skyscraper) and the years it aired: the show's first
// and each season's.
func (s *Server) seriesTitleSet(seriesID int64) ([]string, []int) {
	var out []string
	var years []int
	var title string
	var year int
	s.DB.QueryRow(`SELECT title, year FROM series WHERE id = ?`, seriesID).Scan(&title, &year)
	if title != "" {
		out = append(out, title)
	}
	if year != 0 {
		years = append(years, year)
	}
	collect := func(query string, add func(string)) {
		rows, err := s.DB.Query(query, seriesID)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var v string
			if rows.Scan(&v) == nil && v != "" {
				add(v)
			}
		}
	}
	collect(`SELECT DISTINCT title FROM series_titles WHERE series_id = ?`, func(t string) { out = append(out, t) })
	collect(`SELECT DISTINCT year FROM series_seasons WHERE series_id = ? AND year != 0`, func(y string) {
		if n, _ := strconv.Atoi(y); n != 0 {
			years = append(years, n)
		}
	})
	collect(`SELECT media_id FROM series_provider WHERE series_id = ? AND source = 'anilist'`, func(id string) {
		n, _ := strconv.Atoi(id)
		m, _ := s.Anilist.CachedMedia(n)
		if m == nil || m.Format != "TV" {
			return
		}
		for _, t := range []string{m.Title.Romaji, m.Title.English} {
			if t != "" {
				out = append(out, t)
			}
		}
		if m.SeasonYear != 0 {
			years = append(years, m.SeasonYear)
		}
	})
	return out, years
}
