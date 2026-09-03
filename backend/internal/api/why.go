package api

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// The one-line reasons on the suggestion cards. Built here, in the user's
// language, from the same facts the card shows, so every entry says why it
// is there rather than leaving that to be guessed from the badges.

// whyMissingUnit: a season or film the library lacks while it holds other
// seasons of the show.
func whyMissingUnit(locale string, u *catUnit, locals []UpgradeVariant) string {
	server := u.remotes[0].ServerName
	if u.isMovie {
		return tr(locale, "why.movie", server)
	}
	var seasons []int
	seen := map[int]bool{}
	for _, l := range locals {
		if se := localSeasonOf(l.Folder); se > 0 && !seen[se] {
			seen[se] = true
			seasons = append(seasons, se)
		}
	}
	slices.Sort(seasons)
	return tr(locale, "why.season", u.season, server, epRanges(seasons))
}

// localSeasonOf reads the season a local folder is named for, 0 when the
// folder is not a season folder.
func localSeasonOf(folder string) int {
	base := folder[strings.LastIndex(folder, "/")+1:]
	if m := plexSeasonDirRe.FindStringSubmatch(base); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

// whyUpgrade names what the better copy adds over the local one, axis by
// axis: resolution, then the languages the local copy lacks.
func whyUpgrade(locale string, from, to UpgradeVariant) string {
	var gains []string
	if to.ResRank > from.ResRank {
		gains = append(gains, tr(locale, "why.res", to.ResRank, from.ResRank))
	}
	if add := newCodes(from.Dub, to.Dub); add != "" {
		gains = append(gains, tr(locale, "why.dub", add))
	}
	if add := newCodes(from.Sub, to.Sub); add != "" {
		gains = append(gains, tr(locale, "why.sub", add))
	}
	if add := newCodes(from.Soft, to.Soft); add != "" {
		gains = append(gains, tr(locale, "why.soft", add))
	}
	if len(gains) == 0 {
		return ""
	}
	return tr(locale, "why.upgrade", to.ServerName, strings.Join(gains, ", "))
}

// newCodes lists the language codes in to that from lacks, "Und" aside.
func newCodes(from, to []string) string {
	have := map[string]bool{}
	for _, c := range from {
		have[c] = true
	}
	var add []string
	for _, c := range to {
		if !have[c] && c != "Und" {
			add = append(add, c)
		}
	}
	return strings.Join(add, "+")
}

// epRanges compacts sorted numbers: 4, 6-8, 12.
func epRanges(nums []int) string {
	var parts []string
	for i := 0; i < len(nums); {
		j := i
		for j+1 < len(nums) && nums[j+1] == nums[j]+1 {
			j++
		}
		switch {
		case j == i:
			parts = append(parts, strconv.Itoa(nums[i]))
		case j == i+1:
			parts = append(parts, fmt.Sprintf("%d, %d", nums[i], nums[j]))
		default:
			parts = append(parts, fmt.Sprintf("%d-%d", nums[i], nums[j]))
		}
		i = j + 1
	}
	return strings.Join(parts, ", ")
}

var seasonTokenRe = regexp.MustCompile(`(?i)\bS(\d{1,2})E\d`)

// remoteShowRoot reports whether a remote folder is a whole show rather than
// one season: it holds season folders, or files of more than one season.
func (s *Server) remoteShowRoot(serverID int64, folder string) bool {
	rows, err := s.DB.Query(`SELECT name, is_dir FROM remote_index WHERE server_id = ? AND (parent = ? OR parent LIKE ? || '/%')`,
		serverID, folder, folder)
	if err != nil {
		return false
	}
	defer rows.Close()
	seasons := map[string]bool{}
	for rows.Next() {
		var name string
		var isDir int
		if rows.Scan(&name, &isDir) != nil {
			continue
		}
		if isDir == 1 && plexSeasonDirRe.MatchString(name) {
			return true
		}
		if m := seasonTokenRe.FindStringSubmatch(name); m != nil {
			seasons[strings.TrimLeft(m[1], "0")] = true
		}
	}
	return len(seasons) > 1
}
