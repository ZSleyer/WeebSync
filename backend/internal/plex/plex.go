// Package plex is a minimal read-only client for the Plex Media Server API,
// just enough to list show libraries and locate series folders.
package plex

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
)

type Client struct {
	URL   string // e.g. https://plex.example.com
	Token string
	HTTP  *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{URL: strings.TrimRight(baseURL, "/"), Token: token,
		HTTP: netguard.Client(15 * time.Second)}
}

type Section struct {
	Key   string `json:"key"`
	Type  string `json:"type"` // movie | show | artist
	Title string `json:"title"`
	Agent string `json:"agent"` // e.g. tv.plex.agents.series | tv.plex.agents.movie
	// Provider is which catalog Plex itself uses for this library ("tvdb" |
	// "tmdb" | ""), derived from its episode ordering. The modern Plex agent
	// looks the same for every library and every show carries tvdb, tmdb and
	// imdb guids alike, so the ordering is the only thing that tells them
	// apart.
	Provider string `json:"provider"`
	Ordering string `json:"ordering"` // raw showOrdering value, for the UI hint
	// filesystem roots of the library, for mapping a local path to its library
	Locations []string `json:"-"`
}

// rawSection decodes the nested Location array the section listing carries.
type rawSection struct {
	Section
	Location []struct {
		Path string `json:"path"`
	} `json:"Location"`
}

func (r rawSection) toSection() Section {
	s := r.Section
	for _, l := range r.Location {
		s.Locations = append(s.Locations, l.Path)
	}
	return s
}

type Show struct {
	RatingKey     string `json:"ratingKey"`
	Title         string `json:"title"`
	OriginalTitle string `json:"originalTitle"`
	Year          int    `json:"year"`
	LeafCount     int    `json:"leafCount"`  // episodes present
	ChildCount    int    `json:"childCount"` // seasons present
	Locations     []string
	// authoritative series ids from the show's Guid array, 0 when absent. These
	// heal the aired-order lookup: even when the episodes are locally arranged
	// (a mis-synced library), the matched show still carries the real ids.
	TVDBID int
	TMDBID int
	IMDBID int // numeric part of the "tt…" imdb id, 0 when absent
}

// get fetches path and decodes the MediaContainer payload. The token goes
// into a header, not the query string, so it never lands in access logs.
func (c *Client) get(path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, c.URL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Token", c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("plex: HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// put issues a parameterless-body PUT (Plex mutations carry everything in the
// URL). Token in the header, like get.
func (c *Client) put(path string) error {
	req, err := http.NewRequest(http.MethodPut, c.URL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Plex-Token", c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("plex: HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) Sections() ([]Section, error) {
	var resp struct {
		MediaContainer struct {
			Directory []rawSection `json:"Directory"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/sections", &resp); err != nil {
		return nil, err
	}
	out := make([]Section, 0, len(resp.MediaContainer.Directory))
	for _, d := range resp.MediaContainer.Directory {
		sec := d.toSection()
		if sec.Type == "show" {
			// one extra request per show library (there are a handful) to learn
			// which catalog Plex uses here
			if ord, err := c.SectionPreferences(sec.Key); err == nil {
				sec.Ordering, sec.Provider = ord.Raw, ord.Provider
			}
		}
		if sec.Provider == "" {
			sec.Provider = agentProvider(sec.Agent)
		}
		out = append(out, sec)
	}
	return out, nil
}

// agentProvider recognises the agents that name their catalog outright: the
// legacy ones ("com.plexapp.agents.thetvdb", HAMA) and the modern movie agent,
// which always pulls from TMDB. Only the modern series agent stays ambiguous -
// there the episode ordering decides, which is why show libraries ask Plex for
// their preferences first.
func agentProvider(agent string) string {
	a := strings.ToLower(agent)
	switch {
	case strings.Contains(a, "thetvdb"), strings.Contains(a, "hama"):
		return "tvdb"
	case strings.Contains(a, "themoviedb"), strings.Contains(a, "tv.plex.agents.movie"):
		return "tmdb"
	}
	return ""
}

// LibraryForPath returns the section whose filesystem root is the longest
// prefix of p, so a synced folder can be mapped to its Plex library (and thus
// its metadata agent). Returns false when nothing matches.
func (c *Client) LibraryForPath(p string) (Section, bool) {
	secs, err := c.Sections()
	if err != nil {
		return Section{}, false
	}
	var best Section
	bestLen := -1
	for _, s := range secs {
		for _, root := range s.Locations {
			if (p == root || strings.HasPrefix(p, root+"/")) && len(root) > bestLen {
				best, bestLen = s, len(root)
			}
		}
	}
	return best, bestLen >= 0
}

type rawShow struct {
	Show
	Location []struct {
		Path string `json:"path"`
	} `json:"Location"`
	Guid plexGuids `json:"Guid"`
}

// plexGuids accepts both shapes Plex uses for the show guid: the modern array
// ([{"id":"tvdb://295"},...] from /library/metadata/{key}) and the legacy
// single string ("com.plexapp.agents.thetvdb://295?lang=en" in the bulk
// section listing). Unknown shapes are ignored, never failing the decode.
type plexGuids []string

func (g *plexGuids) UnmarshalJSON(b []byte) error {
	var arr []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &arr); err == nil {
		for _, a := range arr {
			*g = append(*g, a.ID)
		}
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*g = append(*g, s)
	}
	return nil
}

func (r rawShow) toShow() Show {
	s := r.Show
	for _, l := range r.Location {
		s.Locations = append(s.Locations, l.Path)
	}
	for _, g := range r.Guid {
		if n := idFromGuid(g, "tvdb"); n > 0 {
			s.TVDBID = n
		}
		if n := idFromGuid(g, "tmdb"); n > 0 {
			s.TMDBID = n
		}
		if n := idFromGuid(g, "imdb"); n > 0 {
			s.IMDBID = n
		}
	}
	return s
}

// idFromGuid pulls the numeric series id for a provider out of a Plex guid
// string in any of its forms ("tvdb://72454", "themoviedb://30983",
// "com.plexapp.agents.thetvdb://72454?lang=en"), or 0 when it isn't that
// provider's guid. Matching "tmdb" also catches "themoviedb".
func idFromGuid(guid, provider string) int {
	i := strings.Index(strings.ToLower(guid), provider)
	if i < 0 {
		return 0
	}
	rest := guid[i+len(provider):]
	start := strings.IndexFunc(rest, func(r rune) bool { return r >= '0' && r <= '9' })
	if start < 0 {
		return 0
	}
	rest = rest[start:]
	if end := strings.IndexFunc(rest, func(r rune) bool { return r < '0' || r > '9' }); end >= 0 {
		rest = rest[:end]
	}
	n, _ := strconv.Atoi(rest)
	return n
}

// ShowMedia is the quality of a show's local copy, read from a representative
// episode: the highest video height, one episode's file path (Plex's view of
// it, for ffprobe when the mount is shared) and the audio/subtitle languages.
type ShowMedia struct {
	ResHeight int
	File      string
	Dub       []string
	Sub       []string
}

// resHeight maps Plex's videoResolution string ("1080", "720", "4k", "sd") to a
// pixel height.
func resHeight(v string) int {
	switch strings.ToLower(strings.TrimSuffix(v, "p")) {
	case "4k":
		return 2160
	case "sd":
		return 480
	}
	n, _ := strconv.Atoi(strings.TrimSuffix(strings.ToLower(v), "p"))
	return n
}

// ShowMedia reads a show's local quality from its episodes (allLeaves, with
// streams): the max resolution seen, one file path, and the union of audio/
// subtitle languages. Best effort over the first episodes.
func (c *Client) ShowMedia(ratingKey string) (ShowMedia, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []struct {
				Media []struct {
					VideoResolution string `json:"videoResolution"`
					Part            []struct {
						File   string `json:"file"`
						Stream []struct {
							StreamType int    `json:"streamType"` // 1 video, 2 audio, 3 subtitle
							Language   string `json:"language"`
							LangCode   string `json:"languageCode"`
						} `json:"Stream"`
					} `json:"Part"`
				} `json:"Media"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/metadata/"+url.PathEscape(ratingKey)+"/allLeaves?includeStreams=1", &resp); err != nil {
		return ShowMedia{}, err
	}
	var out ShowMedia
	dub, sub := map[string]bool{}, map[string]bool{}
	for i, ep := range resp.MediaContainer.Metadata {
		if i >= 5 { // a handful of episodes is representative
			break
		}
		for _, m := range ep.Media {
			if h := resHeight(m.VideoResolution); h > out.ResHeight {
				out.ResHeight = h
			}
			for _, p := range m.Part {
				if out.File == "" {
					out.File = p.File
				}
				for _, st := range p.Stream {
					lang := st.LangCode
					if lang == "" {
						lang = st.Language
					}
					if lang == "" {
						continue
					}
					if st.StreamType == 2 {
						dub[lang] = true
					} else if st.StreamType == 3 {
						sub[lang] = true
					}
				}
			}
		}
	}
	for l := range dub {
		out.Dub = append(out.Dub, l)
	}
	for l := range sub {
		out.Sub = append(out.Sub, l)
	}
	return out, nil
}

// SeasonMedia reads a show's local quality broken down PER SEASON, keyed by the
// season index (parentIndex on each episode). This is what lets an upgrade
// compare "your season 3" against "the remote season 3" instead of aggregating
// the whole show. For a movie library item the map has one entry under season 0.
// Best effort over up to a few episodes per season.
func (c *Client) SeasonMedia(ratingKey string) (map[int]ShowMedia, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []struct {
				ParentIndex int `json:"parentIndex"` // season number of this episode
				Media       []struct {
					VideoResolution string `json:"videoResolution"`
					Part            []struct {
						File   string `json:"file"`
						Stream []struct {
							StreamType int    `json:"streamType"`
							Language   string `json:"language"`
							LangCode   string `json:"languageCode"`
						} `json:"Stream"`
					} `json:"Part"`
				} `json:"Media"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/metadata/"+url.PathEscape(ratingKey)+"/allLeaves?includeStreams=1", &resp); err != nil {
		return nil, err
	}
	out := map[int]ShowMedia{}
	dub := map[int]map[string]bool{}
	sub := map[int]map[string]bool{}
	count := map[int]int{}
	for _, ep := range resp.MediaContainer.Metadata {
		se := ep.ParentIndex
		if count[se] >= 5 { // a handful of episodes per season is representative
			continue
		}
		count[se]++
		m0 := out[se]
		if dub[se] == nil {
			dub[se], sub[se] = map[string]bool{}, map[string]bool{}
		}
		for _, m := range ep.Media {
			if h := resHeight(m.VideoResolution); h > m0.ResHeight {
				m0.ResHeight = h
			}
			for _, p := range m.Part {
				if m0.File == "" {
					m0.File = p.File
				}
				for _, st := range p.Stream {
					lang := st.LangCode
					if lang == "" {
						lang = st.Language
					}
					if lang == "" {
						continue
					}
					if st.StreamType == 2 {
						dub[se][lang] = true
					} else if st.StreamType == 3 {
						sub[se][lang] = true
					}
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
		out[se] = m0
	}
	return out, nil
}

// EpisodeStream is one audio/subtitle stream of an episode's file, with the
// id needed to select it.
type EpisodeStream struct {
	ID       int64
	Type     int // 2 audio, 3 subtitle
	LangCode string
	Language string
}

// EpisodePart is one episode's media part: its Plex-side file path plus every
// selectable stream. Unlike ShowMedia/SeasonMedia this keeps ids per episode,
// which the stream-selection PUT needs.
type EpisodePart struct {
	RatingKey string
	PartID    int64
	File      string
	Streams   []EpisodeStream
}

// EpisodeParts lists every episode part of a show (allLeaves, with streams).
func (c *Client) EpisodeParts(showRatingKey string) ([]EpisodePart, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []struct {
				RatingKey string `json:"ratingKey"`
				Media     []struct {
					Part []struct {
						ID     int64  `json:"id"`
						File   string `json:"file"`
						Stream []struct {
							ID         int64  `json:"id"`
							StreamType int    `json:"streamType"`
							Language   string `json:"language"`
							LangCode   string `json:"languageCode"`
						} `json:"Stream"`
					} `json:"Part"`
				} `json:"Media"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/metadata/"+url.PathEscape(showRatingKey)+"/allLeaves?includeStreams=1", &resp); err != nil {
		return nil, err
	}
	var out []EpisodePart
	for _, ep := range resp.MediaContainer.Metadata {
		for _, m := range ep.Media {
			for _, p := range m.Part {
				part := EpisodePart{RatingKey: ep.RatingKey, PartID: p.ID, File: p.File}
				for _, st := range p.Stream {
					part.Streams = append(part.Streams, EpisodeStream{
						ID: st.ID, Type: st.StreamType, LangCode: st.LangCode, Language: st.Language,
					})
				}
				out = append(out, part)
			}
		}
	}
	return out, nil
}

// SetStreams selects a part's audio and/or subtitle stream for the token's
// account (0 = leave that dimension untouched).
func (c *Client) SetStreams(partID, audioStreamID, subtitleStreamID int64) error {
	q := url.Values{"allParts": {"1"}}
	if audioStreamID != 0 {
		q.Set("audioStreamID", strconv.FormatInt(audioStreamID, 10))
	}
	if subtitleStreamID != 0 {
		q.Set("subtitleStreamID", strconv.FormatInt(subtitleStreamID, 10))
	}
	return c.put("/library/parts/" + strconv.FormatInt(partID, 10) + "?" + q.Encode())
}

// Shows lists every show of a section (title, year, episode/season counts).
func (c *Client) Shows(sectionKey string) ([]Show, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []rawShow `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	// includeGuids=1 makes the bulk listing carry each show's provider guid
	// array (tvdb://, tmdb://); without it guids only come from a per-show
	// detail fetch. Supported by modern PMS; ignored by old ones (guids stay 0).
	if err := c.get("/library/sections/"+url.PathEscape(sectionKey)+"/all?includeGuids=1", &resp); err != nil {
		return nil, err
	}
	shows := make([]Show, 0, len(resp.MediaContainer.Metadata))
	for _, m := range resp.MediaContainer.Metadata {
		shows = append(shows, m.toShow())
	}
	return shows, nil
}

// Identity is what the server root reports about itself: the machine id for
// Plex Web deep links plus the display name, the linked plex.tv account and
// the server version for the settings status line.
type Identity struct {
	MachineIdentifier string `json:"machineIdentifier"`
	FriendlyName      string `json:"friendlyName"`
	MyPlexUsername    string `json:"myPlexUsername"`
	Version           string `json:"version"`
}

// Identity fetches the server root. A successful call doubles as the
// connection check for the settings page: it needs a valid token.
func (c *Client) Identity() (Identity, error) {
	var resp struct {
		MediaContainer Identity `json:"MediaContainer"`
	}
	if err := c.get("/", &resp); err != nil {
		return Identity{}, err
	}
	return resp.MediaContainer, nil
}

// MachineID returns the server's machine identifier, needed for Plex Web
// deep links.
func (c *Client) MachineID() (string, error) {
	id, err := c.Identity()
	return id.MachineIdentifier, err
}

// ShowDetail fetches one show's full metadata, including the storage
// folder(s) and the original (often Japanese) title. Called lazily for
// suggestion candidates only, to keep Plex request counts low.
func (c *Client) ShowDetail(ratingKey string) (*Show, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []rawShow `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/metadata/"+url.PathEscape(ratingKey), &resp); err != nil {
		return nil, err
	}
	if len(resp.MediaContainer.Metadata) == 0 {
		return nil, fmt.Errorf("plex: show %s not found", ratingKey)
	}
	s := resp.MediaContainer.Metadata[0].toShow()
	return &s, nil
}

// Ordering is the metadata provider + episode order Plex has configured for a
// show. Empty fields mean "not set / library default".
type Ordering struct {
	Provider string // tvdb | tmdb | ""
	Order    string // official | dvd | absolute | aired | ""
	Language string // e.g. de-DE, ja-JP; "" = library default
	Raw      string // the untranslated showOrdering value, for display
}

// SectionPreferences reads a library's own episode ordering. Shows inherit it
// unless they override it, so this is the library-wide answer to "which
// catalog does Plex use here".
func (c *Client) SectionPreferences(key string) (Ordering, error) {
	var resp struct {
		MediaContainer struct {
			Setting []struct {
				ID    string `json:"id"`
				Value string `json:"value"`
			} `json:"Setting"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/sections/"+url.PathEscape(key)+"/prefs", &resp); err != nil {
		return Ordering{}, err
	}
	var o Ordering
	for _, s := range resp.MediaContainer.Setting {
		if s.ID == "showOrdering" {
			o.Raw = s.Value
			o.Provider, o.Order = showOrderingMap(s.Value)
		}
	}
	return o, nil
}

// showOrderingMap turns Plex's showOrdering enum into a provider + episode
// order. "aired" is Plex's alias for TheTVDB aired.
func showOrderingMap(v string) (provider, order string) {
	switch v {
	case "tmdbAiring":
		return "tmdb", "aired"
	case "tvdbAiring", "aired":
		return "tvdb", "official"
	case "tvdbDvd":
		return "tvdb", "dvd"
	case "tvdbAbsolute":
		return "tvdb", "absolute"
	}
	return "", ""
}

// ShowPreferences reads a show's per-title advanced settings: the episode
// ordering (showOrdering) and the metadata language override. These drive how
// downloaded files are renamed so they match exactly what Plex expects.
func (c *Client) ShowPreferences(ratingKey string) (Ordering, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []struct {
				Preferences struct {
					Setting []struct {
						ID    string `json:"id"`
						Value string `json:"value"`
					} `json:"Setting"`
				} `json:"Preferences"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/metadata/"+url.PathEscape(ratingKey)+"?includePreferences=1", &resp); err != nil {
		return Ordering{}, err
	}
	if len(resp.MediaContainer.Metadata) == 0 {
		return Ordering{}, fmt.Errorf("plex: show %s not found", ratingKey)
	}
	var o Ordering
	for _, s := range resp.MediaContainer.Metadata[0].Preferences.Setting {
		switch s.ID {
		case "showOrdering":
			o.Raw = s.Value
			o.Provider, o.Order = showOrderingMap(s.Value)
		case "languageOverride":
			o.Language = s.Value
		}
	}
	return o, nil
}
