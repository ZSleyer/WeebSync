package api

import (
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/relname"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// Room a notification really has: the title is one line, the body two or
// three. Longer text is cut by the system anyway, at a place we do not choose.
const (
	pushTitleMax = 40
	pushBodyMax  = 120
	// series named in a multi-series body before "+n"
	pushMaxSeries = 3
	// episode runs named for one series before an ellipsis
	pushMaxRuns = 3
)

// pushItem is one finished or failed download as the push describes it: what
// the catalog says about the file, not what the server calls it.
type pushItem struct {
	group  string // one series (or folder, when nothing matched)
	title  string // series title; the file's own title when nothing matched
	cover  string
	source string // catalog match, for the link into the app
	media  int
	season int // 0 = none
	ep     int // 0 = none
	epName string
	name   string // cleaned file name, for what has no episode number
	reason string
	id     int64
	local  string
}

// pushItems resolves the digest's items against the catalog. A folder's match
// is looked up once, not once per file.
func (s *Server) pushItems(userID int64, locale string, items []digestItem) []pushItem {
	bySrc, bySeries, _ := s.seriesProviderMaps()
	type folder struct {
		key    string
		g      DownloadGroup
		titles map[int]string
		source string
		media  int
	}
	byDir := map[string]*folder{}
	out := make([]pushItem, 0, len(items))
	for _, it := range items {
		dir := path.Dir(it.remotePath)
		fk := fmt.Sprintf("%d|%s", it.serverID, dir)
		f := byDir[fk]
		if f == nil {
			show := s.showFolder(it.serverID, dir)
			f = &folder{key: fmt.Sprintf("%d|%s", it.serverID, show)}
			f.source, f.media = s.folderMatch(it.serverID, show)
			if f.source != "" && f.media != 0 {
				f.g, f.titles = s.downloadGroup(userID, dlMetaRow{id: it.id, serverID: it.serverID, remotePath: it.remotePath, localPath: it.localPath}, show, bySrc, bySeries, locale)
				// the name the app shows: a watch's own title beats the catalog's
				// full romaji, which would push the episode out of the line
				if f.g.WatchID != 0 {
					var name string
					if s.DB.QueryRow(`SELECT title_override FROM watches WHERE id = ?`, f.g.WatchID).Scan(&name) == nil && strings.TrimSpace(name) != "" {
						f.g.Title = strings.TrimSpace(name)
					}
				}
			}
			byDir[fk] = f
		}
		remote, local := path.Base(it.remotePath), filepath.Base(it.localPath)
		p := pushItem{
			group: f.key, title: f.g.Title, cover: f.g.Cover, source: f.source, media: f.media,
			name: cleanFileName(remote), reason: it.reason(locale),
			id: it.id, local: it.localPath,
		}
		p.season, p.ep = episodeNumbers(local, remote)
		if p.ep > 0 {
			p.epName = f.titles[epKey(p.season, p.ep)]
		}
		if p.title == "" {
			// no usable match: the release name still says which show this is
			p.source, p.media = "", 0
			if t := oneLine(relname.Read(remote).Title); t != "" {
				p.title = t
			} else {
				p.title = p.name
			}
		}
		out = append(out, p)
	}
	return out
}

var (
	bracketTagRe = regexp.MustCompile(`\[[^\]]*\]|\([^)]*\)`)
	spaceRe      = regexp.MustCompile(`\s+`)
)

// cleanFileName is a file name without extension and bracket tags, for when
// nothing better names the file; it falls back to the bare name.
func cleanFileName(base string) string {
	n := strings.TrimSuffix(base, filepath.Ext(base))
	if c := strings.TrimSpace(spaceRe.ReplaceAllString(bracketTagRe.ReplaceAllString(n, " "), " ")); c != "" {
		return oneLine(c)
	}
	return oneLine(n)
}

// httpsOnly keeps an icon the browser can load; a plain-http cover would be
// refused as mixed content and a relative one has no origin to resolve against.
func httpsOnly(u string) string {
	if strings.HasPrefix(u, "https://") {
		return u
	}
	return ""
}

// truncRunes cuts s to max runes, marking the cut.
func truncRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:max-1]), " ,.:-") + "…"
}

type pushEp struct{ season, ep int }

// runsLabel writes episodes for a notification: "Season 4 - Episodes 16-18, 20",
// or "Episodes 16-18" for a show without seasons. Each season's run of
// consecutive numbers collapses and seasons are separated by "; ". Past
// pushMaxRuns runs the rest is elided.
func runsLabel(locale string, eps []pushEp) string {
	eps = uniqueEps(eps)
	sort.Slice(eps, func(i, j int) bool {
		if eps[i].season != eps[j].season {
			return eps[i].season < eps[j].season
		}
		return eps[i].ep < eps[j].ep
	})
	var parts []string
	runs, cut := 0, false
	for i := 0; i < len(eps) && !cut; {
		season := eps[i].season
		var nums []string
		single := true
		for i < len(eps) && eps[i].season == season {
			j := i
			for j+1 < len(eps) && eps[j+1].season == season && eps[j+1].ep-eps[j].ep == 1 {
				j++
			}
			if runs == pushMaxRuns {
				cut = true
				break
			}
			runs++
			nums = append(nums, numRange(eps[i].ep, eps[j].ep))
			single = single && i == j
			i = j + 1
		}
		if len(nums) > 0 {
			parts = append(parts, seasonLabel(locale, season, nums, single && len(nums) == 1))
		}
	}
	out := strings.Join(parts, "; ")
	if cut {
		out += ", …"
	}
	return out
}

func numRange(first, last int) string {
	if last > first {
		return strconv.Itoa(first) + "-" + strconv.Itoa(last)
	}
	return strconv.Itoa(first)
}

// seasonLabel is "Season 4 - Episodes 16-18, 20"; season 0 means the show has
// none. one picks the singular for a lone episode.
func seasonLabel(locale string, season int, nums []string, one bool) string {
	key := "push.episodesNo"
	if one {
		key = "push.episodeNo"
	}
	label := tr(locale, key, strings.Join(nums, ", "))
	if season > 0 {
		return tr(locale, "push.seasonNo", season) + " - " + label
	}
	return label
}

// runLabel names one episode, "Season 4 - Episode 16".
func runLabel(locale string, e pushEp) string {
	return runsLabel(locale, []pushEp{e})
}

func uniqueEps(eps []pushEp) []pushEp {
	seen := map[pushEp]bool{}
	var out []pushEp
	for _, e := range eps {
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	return out
}

// pushGroup is one series' share of a digest.
type pushGroup struct {
	first pushItem
	eps   []pushEp
	n     int
}

// summary is "Series Season 4 - Episodes 16-18" - the series and what of it.
func (g pushGroup) summary(locale string) string {
	if len(g.eps) == 0 {
		return g.first.title
	}
	return g.first.title + " " + runsLabel(locale, g.eps)
}

// buildDownloadPush words the push for a digest of finished (done) or failed
// downloads: one series gets its own title with the episodes in the body,
// several share a count and a list. Pure, so the wording is testable without a
// server. Tag and Timestamp are the caller's.
func buildDownloadPush(locale string, done bool, items []pushItem) push.Notification {
	var groups []*pushGroup
	idx := map[string]*pushGroup{}
	for _, it := range items {
		g := idx[it.group]
		if g == nil {
			g = &pushGroup{first: it}
			idx[it.group] = g
			groups = append(groups, g)
		}
		g.n++
		if it.ep > 0 {
			g.eps = append(g.eps, pushEp{it.season, it.ep})
		}
	}

	var n push.Notification
	data := map[string]string{"url": "/history"}
	one := items[0]
	switch {
	case len(groups) == 1 && done:
		g := groups[0]
		n.Title = g.first.title
		n.Body = oneSeriesBody(locale, g, one)
		if g.first.source != "" {
			data["url"] = "/title/" + url.PathEscape(g.first.source) + "/" + strconv.Itoa(g.first.media)
			// one episode opens the series on that episode
			if uniq := uniqueEps(g.eps); len(uniq) == 1 && g.n == 1 {
				data["url"] += "?ep=" + strconv.Itoa(uniq[0].ep)
				if uniq[0].season > 0 {
					data["url"] += "&s=" + strconv.Itoa(uniq[0].season)
				}
			}
		}
	case done:
		n.Title = tr(locale, "push.downloadDoneMany", len(items))
		n.Body = groupsBody(locale, groups)
	case len(items) == 1:
		n.Title = tr(locale, "push.downloadFailed")
		n.Body = groups[0].summary(locale)
		if one.reason != "" {
			n.Body += ": " + one.reason
		}
	default:
		n.Title = tr(locale, "push.downloadFailedMany", len(items))
		n.Body = groupsBody(locale, groups)
	}

	if len(items) == 1 {
		switch {
		case done && one.local != "" && transfer.VideoExt[strings.ToLower(filepath.Ext(one.local))]:
			// server 0 is the local library, where the file just landed
			data["play"] = "/play?server=0&path=" + url.QueryEscape(one.local)
			n.Actions = append(n.Actions, push.Action{Action: "play", Title: tr(locale, "push.actionPlay")})
		case !done && one.id > 0:
			data["retry"] = "/api/downloads/" + strconv.FormatInt(one.id, 10) + "/resume"
			n.Actions = append(n.Actions, push.Action{Action: "retry", Title: tr(locale, "push.actionRetry")})
		}
	}
	if len(groups) == 1 {
		n.Icon = httpsOnly(groups[0].first.cover)
	}
	n.URL, n.Data = data["url"], data
	if done {
		n.Urgency = "low" // a finished file can wait for the next time the screen is on
	} else {
		n.Urgency = "normal"
	}
	n.Title, n.Body = truncRunes(n.Title, pushTitleMax), truncRunes(n.Body, pushBodyMax)
	return n
}

// oneSeriesBody says what arrived of a single series; the series is the title.
func oneSeriesBody(locale string, g *pushGroup, one pushItem) string {
	switch {
	case g.n == 1 && one.ep > 0:
		label := runLabel(locale, pushEp{one.season, one.ep})
		if one.epName != "" {
			return label + " · " + one.epName
		}
		return tr(locale, "push.itemDone", label)
	case g.n == 1:
		return one.name
	case len(g.eps) > 0:
		return tr(locale, "push.itemDone", runsLabel(locale, g.eps))
	default:
		return tr(locale, "push.filesDone", g.n)
	}
}

// groupsBody lists the series, as many as fit, then how many were left out.
func groupsBody(locale string, groups []*pushGroup) string {
	var parts []string
	used := 0
	for _, g := range groups {
		s := g.summary(locale)
		if len(parts) == pushMaxSeries || (len(parts) > 0 && used+utf8.RuneCountInString(s) > pushBodyMax-8) {
			break
		}
		parts = append(parts, s)
		used += utf8.RuneCountInString(s) + 2
	}
	body := strings.Join(parts, ", ")
	if rest := len(groups) - len(parts); rest > 0 {
		body += fmt.Sprintf(", +%d", rest)
	}
	return body
}
