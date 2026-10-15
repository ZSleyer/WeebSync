package api

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/relname"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/rename"
)

// DownloadGroup is everything the queue knows about one series folder: the
// metadata match, its links, and the watch that feeds it. Downloads are grouped
// by folder rather than carried per row because one show queues dozens of files
// and the cover, description and links are identical for all of them.
type DownloadGroup struct {
	ServerID   int64  `json:"serverId"`
	ServerName string `json:"serverName,omitempty"`
	Folder     string `json:"folder"`          // remote show folder, the parent of a season subfolder
	Title      string `json:"title,omitempty"` // empty when the folder has no catalog match
	Cover      string `json:"cover,omitempty"` // provider poster url, loaded straight by the browser
	// CoverLarge is the same poster at twice the edge (AniList's extraLarge),
	// for a srcset; empty where the provider has only the one size
	CoverLarge string        `json:"coverLarge,omitempty"`
	Overview   string        `json:"overview,omitempty"` // series description, tags stripped
	Providers  []string      `json:"providers,omitempty"`
	Links      ProviderLinks `json:"links"`
	WatchID    int64         `json:"watchId,omitempty"`
}

// DownloadItemMeta is the per-file half: which group it belongs to and which
// episode it is. Field names are short because there is one per download.
type DownloadItemMeta struct {
	Group   string `json:"g"` // group key
	Season  int    `json:"season,omitempty"`
	Episode int    `json:"episode,omitempty"`
	Title   string `json:"title,omitempty"` // episode title, only when the provider cache is warm
	// Res is the video height the file names advertise (1080 for "1080p"),
	// 0 when they say none
	Res int `json:"res,omitempty"`
	// Dub and Sub are the audio and subtitle languages the names advertise,
	// as app language codes ("Ger", "Jap")
	Dub []string `json:"dub,omitempty"`
	Sub []string `json:"sub,omitempty"`
	// Secs and Rate describe a done download's last run: how long it took
	// and its mean speed in bytes per second. Zero when not measured.
	Secs int64 `json:"secs,omitempty"`
	Rate int64 `json:"rate,omitempty"`
}

// DownloadMetaResponse enriches the queue without touching /api/downloads: that
// list is polled every few seconds AND patched in place by the SSE stream, which
// replaces the whole download object per progress tick and would wipe any field
// added to it.
type DownloadMetaResponse struct {
	Groups map[string]DownloadGroup    `json:"groups"` // key "<serverId>|<showFolder>"
	Items  map[string]DownloadItemMeta `json:"items"`  // key: download id
}

// dlMetaRow is one download reduced to what the enrichment reads.
type dlMetaRow struct {
	id         int64
	serverID   int64
	serverName string
	remotePath string
	localPath  string
	status     string
	size       int64
	startBytes int64
	startedAt  string
	updatedAt  string
}

// handleDownloadsMeta describes the user's downloads: series, episode, and the
// links around them.
//
//	@Summary		Download metadata
//	@Description	Series metadata for the authenticated user's downloads (same window as GET /api/downloads): one group per remote series folder with cover, description and provider links, plus one item per download with its season/episode and, when the provider cache is warm, the episode title. Kept apart from the download list because that one is polled and patched by the event stream.
//	@Tags			Downloads
//	@Produce		json
//	@Success		200	{object}	DownloadMetaResponse
//	@Failure		401	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/downloads/meta [get]
func (s *Server) handleDownloadsMeta(w http.ResponseWriter, r *http.Request) {
	resp, err := s.downloadsMeta(auth.UserFrom(r.Context()).ID)
	if err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) downloadsMeta(userID int64) (DownloadMetaResponse, error) {
	resp := DownloadMetaResponse{Groups: map[string]DownloadGroup{}, Items: map[string]DownloadItemMeta{}}
	// the same window as handleDownloadsList, and a LEFT JOIN so a download
	// whose server row is gone still gets an item: the frontend reads "id
	// missing" as "the metadata is older than this download" and refetches.
	rows, err := s.DB.Query(`SELECT d.id, d.server_id, d.remote_path, d.local_path, COALESCE(v.name, ''),
			d.status, d.size, d.start_bytes, d.started_at, COALESCE(d.updated_at, '')
		FROM downloads d LEFT JOIN servers v ON v.id = d.server_id
		WHERE d.user_id = ? ORDER BY d.id DESC LIMIT 500`, userID)
	if err != nil {
		return resp, err
	}
	defer rows.Close()
	var list []dlMetaRow
	for rows.Next() {
		var d dlMetaRow
		if err := rows.Scan(&d.id, &d.serverID, &d.remotePath, &d.localPath, &d.serverName,
			&d.status, &d.size, &d.startBytes, &d.startedAt, &d.updatedAt); err != nil {
			return resp, err
		}
		list = append(list, d)
	}
	rows.Close()

	bySrc, bySeries, _ := s.seriesProviderMaps()
	locale := s.userLocale(userID)
	showOf := map[string]string{}           // "<serverId>|<fileDir>" -> show folder
	epTitles := map[string]map[int]string{} // group key -> episode title by epKey
	for _, d := range list {
		dir := path.Dir(d.remotePath)
		fk := fmt.Sprintf("%d|%s", d.serverID, dir)
		folder, ok := showOf[fk]
		if !ok {
			folder = s.showFolder(d.serverID, dir)
			showOf[fk] = folder
		}
		gk := fmt.Sprintf("%d|%s", d.serverID, folder)
		if _, ok := resp.Groups[gk]; !ok {
			g, titles := s.downloadGroup(userID, d, folder, bySrc, bySeries, locale)
			resp.Groups[gk] = g
			if titles != nil {
				epTitles[gk] = titles
			}
		}
		it := DownloadItemMeta{Group: gk}
		it.Season, it.Episode = episodeNumbers(path.Base(d.localPath), path.Base(d.remotePath))
		if it.Episode > 0 {
			it.Title = epTitles[gk][epKey(it.Season, it.Episode)]
		}
		it.Res, it.Dub, it.Sub = fileFacts(path.Base(d.localPath), path.Base(d.remotePath))
		if d.status == "done" {
			it.Secs, it.Rate = runFacts(d.startedAt, d.updatedAt, d.size-d.startBytes)
		}
		resp.Items[strconv.FormatInt(d.id, 10)] = it
	}
	return resp, nil
}

// showFolder picks the folder that carries the series match: the file's own
// directory, or its parent when the files sit in a season subfolder. Falls back
// to the file's directory so unmatched downloads still group by where they live.
func (s *Server) showFolder(serverID int64, dir string) string {
	for _, d := range []string{dir, path.Dir(dir)} {
		if src, id := s.folderMatch(serverID, d); src != "" && id != 0 {
			return d
		}
	}
	return dir
}

// folderMatch reads a folder's catalog match.
func (s *Server) folderMatch(serverID int64, folder string) (source string, mediaID int) {
	s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = ? AND folder = ? AND media_id != 0`,
		serverID, folder).Scan(&source, &mediaID)
	return
}

// downloadGroup builds one folder's metadata. Everything here runs once per
// folder, not once per download - a show queues dozens of files.
func (s *Server) downloadGroup(userID int64, d dlMetaRow, folder string, bySrc map[string]int64, bySeries map[int64][]providerRef, locale string) (DownloadGroup, map[int]string) {
	g := DownloadGroup{ServerID: d.serverID, ServerName: d.serverName, Folder: folder}
	source, mediaID := s.folderMatch(d.serverID, folder)
	if source == "" || mediaID == 0 {
		return g, nil // no match: the frontend keeps showing the file name
	}
	if m, _ := s.sourceMedia(source, mediaID); m != nil {
		g.Title, g.Cover, g.Overview = mediaTitle(m), m.CoverImage.Large, plainText(m.Description)
		g.CoverLarge = m.CoverImage.ExtraLarge
	}

	refs := []providerRef{{source, mediaID}}
	if sid := bySrc[source+"|"+strconv.Itoa(mediaID)]; sid != 0 {
		refs = bySeries[sid] // the bundled series knows every provider, not just this folder's
	}
	set, links := providerLinks(refs)
	showKey, _, _ := s.folderUnit(d.serverID, folder)
	// deliberately NOT providerBadgesLinks: its Plex branch falls back to the
	// guid index, which walks the whole library on a cold cache. This endpoint
	// is polled, so only the id lookup (one query) is affordable.
	if rk, _ := s.plexRatingKeyFor(showKey); rk != "" {
		if c := s.plexClient(); c != nil {
			if l := s.plexLinkFor(c, rk); l != "" {
				set["plex"], links.Plex = true, l
			}
		}
	}
	g.Providers, g.Links = keysSorted(set), links

	var ordering string
	s.DB.QueryRow(`SELECT id, rename_ordering FROM watches
		WHERE user_id = ? AND server_id = ? AND ? LIKE remote_path || '%'
		ORDER BY length(remote_path) DESC LIMIT 1`, userID, d.serverID, folder).Scan(&g.WatchID, &ordering)
	return g, s.episodeTitles(showKey, ordering, locale)
}

// episodeTitles maps epKey -> episode title from the TVDB cache alone. A miss
// queues a background fetch and returns nothing: the queue view is polled and
// must never wait on a provider for a nice-to-have. Titles show up on the next
// poll once the cache is warm.
func (s *Server) episodeTitles(showKey, ordering, locale string) map[int]string {
	id, ok := strings.CutPrefix(showKey, "tvdb:")
	if !ok || s.Tvdb == nil || !s.Tvdb.Enabled() {
		return nil
	}
	seriesID, err := strconv.Atoi(id)
	if err != nil || seriesID <= 0 {
		return nil
	}
	// TVDB's season types are official|dvd|absolute; "aired" is TMDB's word for
	// the same thing and would 404 (see watchProviderFor).
	if ordering == "" || ordering == "aired" {
		ordering = "official"
	}
	eps, hit := s.Tvdb.EpisodesCached(seriesID, ordering, locale)
	if !hit {
		s.runJob(fmt.Sprintf("dlmeta:eps:%d:%s:%s", seriesID, ordering, locale), func(ctx context.Context) {
			s.Tvdb.EpisodesLang(ctx, seriesID, ordering, locale)
		})
		return nil
	}
	out := make(map[int]string, len(eps))
	for _, e := range eps {
		if e.Name != "" {
			out[epKey(e.SeasonNumber, e.Number)] = e.Name
		}
	}
	return out
}

// episodeNumbers reads season and episode off the already renamed target name,
// falling back to the remote name for downloads without a rename rule. The local
// name is the better source: it is what the watch's template produced, so it
// already carries the aired-order correction that turns an absolute 1187 into
// S34E01. Pure - the queue view must not touch a provider.
func episodeNumbers(localBase, remoteBase string) (season, episode int) {
	for _, name := range []string{localBase, remoteBase} {
		if name == "" {
			continue
		}
		p := relname.Read(name)
		if len(p.Episodes) == 0 {
			continue
		}
		// fractional numbers (the ".5" recap convention) have no integer
		// episode; they keep showing their file name instead
		ep, err := strconv.Atoi(p.Episodes[0])
		if err != nil {
			continue
		}
		return p.Season, ep
	}
	return 0, 0
}

var tagRe = regexp.MustCompile(`<[^>]*>`)

// plainText strips the markup a provider description carries (AniList sends
// <br> and <i>), because the frontend renders it as text.
func plainText(s string) string {
	s = tagRe.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(html.UnescapeString(s)), " ")
}

// fileFacts reads what a download's names advertise: the video height and the
// audio and subtitle languages. The remote name is read too: a rename template
// often drops the release tags the original carried. Pure, like
// episodeNumbers - the queue view must not open a file.
func fileFacts(localBase, remoteBase string) (res int, dub, sub []string) {
	seenDub, seenSub := map[string]bool{}, map[string]bool{}
	add := func(tag string, seen map[string]bool, out *[]string) {
		for _, c := range rename.Codes(tag) {
			if lang, ok := iso639[strings.ToLower(c)]; ok {
				c = lang
			} else {
				c = canonCode(c)
			}
			if !seen[c] {
				seen[c] = true
				*out = append(*out, c)
			}
		}
	}
	for _, name := range []string{localBase, remoteBase} {
		if name == "" {
			continue
		}
		if r := rename.Resolution(name); r > res {
			res = r
		}
		d, s := rename.LangTags(name)
		add(d, seenDub, &dub)
		add(s, seenSub, &sub)
	}
	return res, dub, sub
}

// runFacts measures a finished run from its start to its last write (both as
// SQLite writes datetime('now')) over the bytes it moved: the seconds it took
// and the mean rate. Zero when either time is missing or the run took no
// measurable time.
func runFacts(startedAt, endedAt string, moved int64) (secs, rate int64) {
	const layout = "2006-01-02 15:04:05"
	a, err1 := time.Parse(layout, startedAt)
	b, err2 := time.Parse(layout, endedAt)
	if err1 != nil || err2 != nil || !b.After(a) {
		return 0, 0
	}
	secs = int64(b.Sub(a) / time.Second)
	if moved > 0 {
		rate = moved / secs
	}
	return secs, rate
}
