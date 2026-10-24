// Package jellyfin is a read-mostly client for the Jellyfin server API that
// answers in the plex package's types, so every library feature built against
// plex.Server works on a Jellyfin library unchanged.
//
// Two things differ from Plex and are absorbed here:
//   - Jellyfin item ids are 128-bit GUIDs, while a show's RatingKey is stored
//     as an integer media id. RatingKey is therefore the decimal value of the
//     id's first 60 bits; the client maps it back through its show listing.
//   - Plex files every folder of one show under one item (One_Piece and
//     One_Piece_GerDub share a TVDB id, so they are one show with two
//     locations). Jellyfin makes one series per folder, so series of one
//     library sharing a TVDB (else TMDB) id are bundled into one Show.
package jellyfin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/plex"
)

type Client struct {
	URL   string
	Token string // API key or a user's access token
	HTTP  *http.Client
	// DeviceID identifies this instance in Jellyfin's device list; empty sends
	// a fixed one
	DeviceID string

	mu       sync.Mutex
	userID   string
	sections []plex.Section
	shows    map[string][]plex.Show // per section key
	groups   map[string][]string    // RatingKey -> Jellyfin ids it bundles
}

var _ plex.Server = (*Client)(nil)

func New(baseURL, token string) *Client {
	return &Client{URL: strings.TrimRight(baseURL, "/"), Token: token,
		HTTP: netguard.Client(15 * time.Second), groups: map[string][]string{}, shows: map[string][]plex.Show{}}
}

func (c *Client) Kind() string { return "jellyfin" }

// AuthHeader is the Authorization value every Jellyfin client sends. 12.x only
// accepts the token here (the X-Emby-Token header is legacy and off by
// default); an empty token is the anonymous form the sign-in calls use.
func AuthHeader(deviceID, token string) string {
	if deviceID == "" {
		deviceID = "weebsync"
	}
	h := fmt.Sprintf(`MediaBrowser Client="%s", Device="WeebSync", DeviceId="%s", Version="1"`, plex.Product, deviceID)
	if token != "" {
		h += fmt.Sprintf(`, Token="%s"`, token)
	}
	return h
}

type errStatus int

func (e errStatus) Error() string { return fmt.Sprintf("jellyfin: HTTP %d", int(e)) }

// Do sends one request; out (when non-nil) receives the decoded JSON body.
func (c *Client) Do(method, p string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.URL+p, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", AuthHeader(c.DeviceID, c.Token))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return errStatus(resp.StatusCode)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out)
}

func (c *Client) get(p string, out any) error { return c.Do(http.MethodGet, p, nil, out) }

// User is a Jellyfin account as the API reports it.
type User struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Policy struct {
		IsAdministrator bool `json:"IsAdministrator"`
	} `json:"Policy"`
}

// Me is the token's own user; an API key belongs to nobody and fails here.
func (c *Client) Me() (User, error) {
	var u User
	err := c.get("/Users/Me", &u)
	return u, err
}

// user is whose view of the library the item queries take. Counts (seasons,
// episodes) are only filled in for a user, and an API key has none, so it
// borrows the first administrator, who sees every library.
func (c *Client) user() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.userID != "" {
		return c.userID, nil
	}
	if u, err := c.Me(); err == nil && u.ID != "" {
		c.userID = u.ID
		return u.ID, nil
	}
	var users []User
	if err := c.get("/Users", &users); err != nil {
		return "", err
	}
	for _, u := range users {
		if u.Policy.IsAdministrator {
			c.userID = u.ID
			return u.ID, nil
		}
	}
	return "", fmt.Errorf("jellyfin: no administrator account visible to this token")
}

type systemInfo struct {
	ID         string `json:"Id"`
	ServerName string `json:"ServerName"`
	Version    string `json:"Version"`
}

// Identity doubles as the connection check: /System/Info needs a valid token.
// MyPlexUsername carries the signed-in user, empty for an API key.
func (c *Client) Identity() (plex.Identity, error) {
	var si systemInfo
	if err := c.get("/System/Info", &si); err != nil {
		return plex.Identity{}, err
	}
	id := plex.Identity{MachineIdentifier: si.ID, FriendlyName: si.ServerName, Version: si.Version}
	if u, err := c.Me(); err == nil {
		id.MyPlexUsername = u.Name
	}
	return id, nil
}

func (c *Client) MachineID() (string, error) {
	var si systemInfo
	err := c.get("/System/Info/Public", &si)
	return si.ID, err
}

// DeepLink opens the item in Jellyfin's own web app; unlike Plex there is no
// hosted app that reaches a server from anywhere.
func (c *Client) DeepLink(serverID, ratingKey string) string {
	ids := c.ids(ratingKey)
	if len(ids) == 0 {
		return ""
	}
	return c.URL + "/web/#/details?id=" + url.QueryEscape(ids[0]) + "&serverId=" + url.QueryEscape(serverID)
}

type virtualFolder struct {
	Name           string   `json:"Name"`
	ItemID         string   `json:"ItemId"`
	CollectionType string   `json:"CollectionType"`
	Locations      []string `json:"Locations"`
	LibraryOptions struct {
		TypeOptions []struct {
			Type             string   `json:"Type"`
			MetadataFetchers []string `json:"MetadataFetchers"`
		} `json:"TypeOptions"`
	} `json:"LibraryOptions"`
}

// Sections lists the libraries (admin only), memoised like Plex's.
func (c *Client) Sections() ([]plex.Section, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sections != nil {
		return c.sections, nil
	}
	var vfs []virtualFolder
	if err := c.get("/Library/VirtualFolders", &vfs); err != nil {
		return nil, err
	}
	out := make([]plex.Section, 0, len(vfs))
	for _, v := range vfs {
		sec := plex.Section{Key: v.ItemID, Title: v.Name, Agent: "jellyfin", Locations: v.Locations, Provider: "tmdb"}
		switch v.CollectionType {
		case "tvshows":
			sec.Type = "show"
		case "movies":
			sec.Type = "movie"
		case "music":
			sec.Type = "artist"
		default:
			sec.Type = v.CollectionType
		}
		// TMDB is the only built-in series catalog; the TheTVDB plugin is
		// what makes a library tvdb-ordered, and its first enabled fetcher wins
		for _, t := range v.LibraryOptions.TypeOptions {
			if (t.Type == "Series" && sec.Type == "show") || (t.Type == "Movie" && sec.Type == "movie") {
				if len(t.MetadataFetchers) > 0 && strings.Contains(strings.ToLower(t.MetadataFetchers[0]), "tvdb") {
					sec.Provider = "tvdb"
				}
				if len(t.MetadataFetchers) > 0 {
					sec.Ordering = t.MetadataFetchers[0]
				}
			}
		}
		out = append(out, sec)
	}
	c.sections = out
	return out, nil
}

func (c *Client) LibraryForPath(p string) (plex.Section, bool) {
	secs, err := c.Sections()
	if err != nil {
		return plex.Section{}, false
	}
	return plex.SectionForPath(secs, p)
}

// ShowKeyForPath finds the show whose folder is p or holds p. Jellyfin has no
// by-folder view, but every series carries its path, so the library's own
// listing answers it; a folder above several shows answers nothing, as on Plex.
func (c *Client) ShowKeyForPath(p string) (string, bool) {
	lib, ok := c.LibraryForPath(p)
	if !ok {
		return "", false
	}
	shows, err := c.Shows(lib.Key)
	if err != nil {
		return "", false
	}
	p = strings.TrimRight(p, "/")
	for _, sh := range shows {
		for _, loc := range sh.Locations {
			if p == loc || strings.HasPrefix(p, loc+"/") {
				return sh.RatingKey, true
			}
		}
	}
	return "", false
}

type item struct {
	ID                 string            `json:"Id"`
	Name               string            `json:"Name"`
	OriginalTitle      string            `json:"OriginalTitle"`
	Type               string            `json:"Type"`
	Path               string            `json:"Path"`
	ProductionYear     int               `json:"ProductionYear"`
	ChildCount         int               `json:"ChildCount"`
	RecursiveItemCount int               `json:"RecursiveItemCount"`
	DisplayOrder       string            `json:"DisplayOrder"`
	PreferredLanguage  string            `json:"PreferredMetadataLanguage"`
	ProviderIds        map[string]string `json:"ProviderIds"`
	IndexNumber        int               `json:"IndexNumber"`
	ParentIndexNumber  int               `json:"ParentIndexNumber"`
	LocationType       string            `json:"LocationType"`
	MediaStreams       []mediaStream     `json:"MediaStreams"`
}

type itemPage struct {
	Items            []item `json:"Items"`
	TotalRecordCount int    `json:"TotalRecordCount"`
}

const showFields = "ProviderIds,Path,OriginalTitle,ChildCount,RecursiveItemCount,ProductionYear,DisplayOrder,PreferredMetadataLanguage"

var pageSize = 500 // var so the test can shrink it

// ShortKey is the RatingKey of a Jellyfin id: its first 60 bits in decimal,
// positive and within int64 so it fits a series_provider media id.
// ponytail: 60 bits of an MD5 per library; a collision needs ~10^9 items.
func ShortKey(id string) string {
	id = strings.ReplaceAll(id, "-", "")
	if len(id) < 15 {
		return ""
	}
	n, err := strconv.ParseUint(id[:15], 16, 64)
	if err != nil || n == 0 {
		return ""
	}
	return strconv.FormatUint(n, 10)
}

func providerID(ids map[string]string, key string) int {
	for k, v := range ids {
		if strings.EqualFold(k, key) {
			n, _ := strconv.Atoi(strings.TrimPrefix(strings.ToLower(v), "tt"))
			return n
		}
	}
	return 0
}

// Shows lists a library's series (or movies), bundled per catalog id.
func (c *Client) Shows(sectionKey string) ([]plex.Show, error) {
	c.mu.Lock()
	if sh, ok := c.shows[sectionKey]; ok {
		c.mu.Unlock()
		return sh, nil
	}
	c.mu.Unlock()
	uid, err := c.user()
	if err != nil {
		return nil, err
	}
	var items []item
	for start := 0; ; start += pageSize {
		q := url.Values{"userId": {uid}, "parentId": {sectionKey}, "recursive": {"true"},
			"includeItemTypes": {"Series,Movie"}, "fields": {showFields},
			"startIndex": {strconv.Itoa(start)}, "limit": {strconv.Itoa(pageSize)}, "enableTotalRecordCount": {"true"}}
		var page itemPage
		if err := c.get("/Items?"+q.Encode(), &page); err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if len(page.Items) < pageSize || len(items) >= page.TotalRecordCount {
			break
		}
	}
	shows := c.bundle(items)
	c.mu.Lock()
	c.shows[sectionKey] = shows
	c.mu.Unlock()
	return shows, nil
}

// bundle folds series sharing a TVDB (else TMDB) id into one show, the way
// Plex files them, and remembers which ids each RatingKey stands for.
func (c *Client) bundle(items []item) []plex.Show {
	sort.SliceStable(items, func(i, j int) bool { return items[i].Path < items[j].Path })
	var out []plex.Show
	at := map[string]int{} // catalog id -> index in out
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, it := range items {
		sh := toShow(it)
		if sh.RatingKey == "" {
			continue
		}
		key := ""
		if it.Type == "Series" {
			if sh.TVDBID > 0 {
				key = "tvdb:" + strconv.Itoa(sh.TVDBID)
			} else if sh.TMDBID > 0 {
				key = "tmdb:" + strconv.Itoa(sh.TMDBID)
			}
		}
		if i, ok := at[key]; ok && key != "" {
			o := &out[i]
			o.Locations = append(o.Locations, sh.Locations...)
			o.LeafCount += sh.LeafCount
			o.ChildCount = max(o.ChildCount, sh.ChildCount)
			c.groups[o.RatingKey] = append(c.groups[o.RatingKey], it.ID)
			continue
		}
		if key != "" {
			at[key] = len(out)
		}
		c.groups[sh.RatingKey] = []string{it.ID}
		out = append(out, sh)
	}
	if out == nil {
		out = []plex.Show{}
	}
	return out
}

func toShow(it item) plex.Show {
	sh := plex.Show{RatingKey: ShortKey(it.ID), Title: it.Name, OriginalTitle: it.OriginalTitle,
		Year: it.ProductionYear, ChildCount: it.ChildCount,
		TVDBID: providerID(it.ProviderIds, "Tvdb"), TMDBID: providerID(it.ProviderIds, "Tmdb"),
		IMDBID: providerID(it.ProviderIds, "Imdb")}
	if it.Type == "Series" {
		// a movie has no Location on Plex either, only its file
		sh.LeafCount = it.RecursiveItemCount
		if it.Path != "" {
			sh.Locations = []string{it.Path}
		}
	}
	return sh
}

// ids resolves a RatingKey to the Jellyfin ids it bundles, listing every
// library once when this client has not seen the key yet.
func (c *Client) ids(ratingKey string) []string {
	ids, _ := c.lookupIDs(ratingKey)
	return ids
}

// lookupIDs is ids with the reason for an empty answer: plex.ErrNotFound when
// every library was read and none lists the key, the server's error when a
// library could not be read (the key may well be in it).
func (c *Client) lookupIDs(ratingKey string) ([]string, error) {
	c.mu.Lock()
	ids, ok := c.groups[ratingKey]
	c.mu.Unlock()
	if ok {
		return ids, nil
	}
	secs, err := c.Sections()
	if err != nil {
		return nil, err
	}
	var listErr error
	for _, s := range secs {
		if s.Type != "show" && s.Type != "movie" {
			continue
		}
		if _, err := c.Shows(s.Key); err != nil {
			listErr = err
			continue
		}
		c.mu.Lock()
		ids, ok = c.groups[ratingKey]
		c.mu.Unlock()
		if ok {
			return ids, nil
		}
	}
	if listErr != nil {
		return nil, listErr
	}
	return nil, fmt.Errorf("jellyfin: show %s: %w", ratingKey, plex.ErrNotFound)
}

func (c *Client) items(ids []string, fields string) ([]item, error) {
	uid, err := c.user()
	if err != nil {
		return nil, err
	}
	q := url.Values{"userId": {uid}, "ids": {strings.Join(ids, ",")}, "fields": {fields}}
	var page itemPage
	if err := c.get("/Items?"+q.Encode(), &page); err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (c *Client) ShowDetail(ratingKey string) (*plex.Show, error) {
	ids, err := c.lookupIDs(ratingKey)
	if err != nil {
		return nil, err
	}
	its, err := c.items(ids, showFields)
	if err != nil {
		return nil, err
	}
	if len(its) == 0 {
		return nil, fmt.Errorf("jellyfin: show %s: %w", ratingKey, plex.ErrNotFound)
	}
	sh := toShow(its[0])
	sh.RatingKey = ratingKey
	for _, it := range its[1:] {
		o := toShow(it)
		sh.Locations = append(sh.Locations, o.Locations...)
		sh.LeafCount += o.LeafCount
		sh.ChildCount = max(sh.ChildCount, o.ChildCount)
	}
	return &sh, nil
}

// ShowPreferences maps a series' display order onto Plex's provider + order.
// Jellyfin sets no per-series catalog, so the provider is the library's.
func (c *Client) ShowPreferences(ratingKey string) (plex.Ordering, error) {
	ids := c.ids(ratingKey)
	if len(ids) == 0 {
		return plex.Ordering{}, fmt.Errorf("jellyfin: show %s not found", ratingKey)
	}
	its, err := c.items(ids[:1], showFields)
	if err != nil || len(its) == 0 {
		return plex.Ordering{}, fmt.Errorf("jellyfin: show %s not found", ratingKey)
	}
	it := its[0]
	o := plex.Ordering{Raw: it.DisplayOrder, Language: it.PreferredLanguage}
	if lib, ok := c.LibraryForPath(it.Path); ok {
		o.Provider = lib.Provider
	}
	switch strings.ToLower(it.DisplayOrder) {
	case "absolute":
		o.Order = "absolute"
	case "dvd":
		o.Order = "dvd"
	case "", "aired", "originalairdate":
		if o.Provider == "tvdb" {
			o.Order = "official" // TVDB's aired order, as Plex names it
		} else if o.Provider == "tmdb" {
			o.Order = "aired"
		}
	default: // story arcs, production order: nothing a rename can follow
		o.Provider = ""
	}
	return o, nil
}

type mediaStream struct {
	Type              string `json:"Type"` // Video | Audio | Subtitle
	Index             int64  `json:"Index"`
	Language          string `json:"Language"`
	Title             string `json:"Title"`
	DisplayTitle      string `json:"DisplayTitle"`
	IsForced          bool   `json:"IsForced"`
	IsHearingImpaired bool   `json:"IsHearingImpaired"`
	Width             int    `json:"Width"`
	Height            int    `json:"Height"`
}

// resHeight buckets a frame the way Plex's videoResolution does: by width, so
// a 1920x800 scope encode is still "1080".
func resHeight(w, h int) int {
	switch {
	case w >= 3200 || h >= 1800:
		return 2160
	case w >= 1600 || h >= 900:
		return 1080
	case w >= 1100 || h >= 650:
		return 720
	case w > 0 || h > 0:
		return 480
	}
	return 0
}

// episodes lists the files of every series a RatingKey bundles. Missing
// (virtual) episodes are left out: Plex only lists what is on disk.
func (c *Client) episodes(ratingKey, fields string) ([]item, error) {
	ids := c.ids(ratingKey)
	if len(ids) == 0 {
		return nil, fmt.Errorf("jellyfin: show %s not found", ratingKey)
	}
	uid, err := c.user()
	if err != nil {
		return nil, err
	}
	var out []item
	for _, id := range ids {
		q := url.Values{"userId": {uid}, "isMissing": {"false"}, "fields": {fields}}
		var page itemPage
		err := c.get("/Shows/"+url.PathEscape(id)+"/Episodes?"+q.Encode(), &page)
		var st errStatus
		if (err == nil && len(page.Items) == 0) || (errors.As(err, &st) && st == http.StatusNotFound) {
			// a movie is its own single file, like a Plex movie's one leaf
			its, ierr := c.items([]string{id}, fields)
			if ierr != nil {
				return nil, ierr
			}
			for _, it := range its {
				if it.Type == "Movie" {
					out = append(out, it)
				}
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, it := range page.Items {
			if it.LocationType != "Virtual" {
				out = append(out, it)
			}
		}
	}
	return out, nil
}

// countsAs mirrors the Plex rule: a forced subtitle track is signs, not a
// translation, so it adds no language.
func (st mediaStream) countsAs() string {
	if st.Type == "Subtitle" && (st.IsForced || plex.ForcedTitle(st.Title) || plex.ForcedTitle(st.DisplayTitle)) {
		return ""
	}
	return st.Language
}

func (c *Client) SeasonMedia(ratingKey string) (map[int]plex.ShowMedia, error) {
	eps, err := c.episodes(ratingKey, "MediaStreams,Path")
	if err != nil {
		return nil, err
	}
	out := map[int]plex.ShowMedia{}
	dub, sub, count := map[int]map[string]bool{}, map[int]map[string]bool{}, map[int]int{}
	for _, ep := range eps {
		se := ep.ParentIndexNumber
		if count[se] >= 5 { // a handful of episodes per season is representative
			continue
		}
		count[se]++
		m0 := out[se]
		if dub[se] == nil {
			dub[se], sub[se] = map[string]bool{}, map[string]bool{}
		}
		if m0.File == "" {
			m0.File = ep.Path
		}
		for _, st := range ep.MediaStreams {
			switch st.Type {
			case "Video":
				m0.ResHeight = max(m0.ResHeight, resHeight(st.Width, st.Height))
			case "Audio":
				if l := st.countsAs(); l != "" {
					dub[se][l] = true
				}
			case "Subtitle":
				if l := st.countsAs(); l != "" {
					sub[se][l] = true
				}
			}
		}
		out[se] = m0
	}
	for se, m0 := range out {
		for l := range dub[se] {
			m0.Dub = append(m0.Dub, l)
		}
		for l := range sub[se] {
			m0.Sub = append(m0.Sub, l)
		}
		sort.Strings(m0.Dub)
		sort.Strings(m0.Sub)
		out[se] = m0
	}
	return out, nil
}

func (c *Client) Episodes(showRatingKey string) ([]plex.Episode, error) {
	eps, err := c.episodes(showRatingKey, "Path")
	if err != nil {
		return nil, err
	}
	out := make([]plex.Episode, 0, len(eps))
	for _, e := range eps {
		if e.Type == "Episode" && e.IndexNumber > 0 {
			out = append(out, plex.Episode{Season: e.ParentIndexNumber, Episode: e.IndexNumber})
		}
	}
	return out, nil
}

func parts(eps []item) []plex.EpisodePart {
	out := make([]plex.EpisodePart, 0, len(eps))
	for _, e := range eps {
		p := plex.EpisodePart{RatingKey: e.ID, File: e.Path}
		for _, st := range e.MediaStreams {
			t := map[string]int{"Audio": 2, "Subtitle": 3}[st.Type]
			if t == 0 {
				continue
			}
			title := st.Title
			if title == "" {
				title = st.DisplayTitle
			}
			p.Streams = append(p.Streams, plex.EpisodeStream{ID: st.Index, Type: t, LangCode: st.Language,
				Language: st.Language, Forced: st.IsForced, HearingImpaired: st.IsHearingImpaired, Title: title})
		}
		out = append(out, p)
	}
	return out
}

func (c *Client) EpisodeParts(showRatingKey string) ([]plex.EpisodePart, error) {
	eps, err := c.episodes(showRatingKey, "MediaStreams,Path")
	if err != nil {
		return nil, err
	}
	return parts(eps), nil
}

// PartStreams takes an episode's own Jellyfin id, as EpisodeParts hands it out.
func (c *Client) PartStreams(episodeRatingKey string) ([]plex.EpisodePart, error) {
	its, err := c.items([]string{episodeRatingKey}, "MediaStreams,Path")
	if err != nil {
		return nil, err
	}
	return parts(its), nil
}

// SetStreams: Jellyfin keeps no per-item track choice a client could set; it
// picks tracks at play time from the user's language preferences and the
// file's default/forced flags.
func (c *Client) SetStreams(int64, int64, int64) error { return plex.ErrUnsupported }

// Refresh reports a changed folder, which Jellyfin scans on its own schedule
// shortly after (the call is debounced server-side). The section key is not
// needed: the path alone names the library.
func (c *Client) Refresh(_, dir string) error {
	body := map[string]any{"Updates": []map[string]string{{"Path": path.Clean(dir), "UpdateType": "Modified"}}}
	return c.Do(http.MethodPost, "/Library/Media/Updated", body, nil)
}
