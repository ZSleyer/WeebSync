package api

import (
	"path"
	"regexp"
	"strconv"

	"github.com/nssteinbrenner/anitogo"
)

// PlayAnilist ties a playing file to the user's AniList list: the title its
// folder matched, the episode its name gives and how far the list is. Only
// for a title already on the list, so watching never adds one.
type PlayAnilist struct {
	MediaID  int `json:"mediaId"`
	Episode  int `json:"episode"`
	Progress int `json:"progress"`
}

var sxeEpisodeRe = regexp.MustCompile(`(?i)\bS\d{1,3}E(\d{1,4})`)

// episodeOf reads the episode number from a file name: SxxEyy first, else
// anitogo's guess. 0 when there is none.
func episodeOf(name string) int {
	if m := sxeEpisodeRe.FindStringSubmatch(name); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	p := anitogo.Parse(name, anitogo.DefaultOptions)
	if len(p.EpisodeNumber) > 0 {
		n, _ := strconv.Atoi(p.EpisodeNumber[0])
		return n
	}
	return 0
}

// playAnilist finds the AniList entry behind a file, nil when the account is
// not linked or the user has not allowed list changes, the folder is not matched to AniList, the name gives no
// episode, or the title is not on the user's list.
func (s *Server) playAnilist(src playSource) *PlayAnilist {
	alID, _, err := s.anilistAccount(src.userID)
	if err != nil || !s.anilistPerms(src.userID).List {
		return nil
	}
	ep := episodeOf(path.Base(src.path))
	if ep <= 0 {
		return nil
	}
	// the title folder, or the one above it when episodes sit in seasons
	dir := path.Dir(src.path)
	var mediaID int
	if s.DB.QueryRow(`SELECT media_id FROM catalog_matches
		WHERE server_id = ? AND folder IN (?, ?) AND source = 'anilist' AND media_id != 0
		ORDER BY length(folder) DESC LIMIT 1`, src.serverID, dir, path.Dir(dir)).Scan(&mediaID) != nil {
		return nil
	}
	for _, e := range s.Anilist.CachedUserList(alID) {
		if e.Media.ID == mediaID {
			return &PlayAnilist{MediaID: mediaID, Episode: ep, Progress: e.Progress}
		}
	}
	return nil
}
