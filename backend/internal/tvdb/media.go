package tvdb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
)

// This file makes TVDB a catalog metadata source alongside AniList and TMDB:
// it maps a TVDB series into the shared anilist.Media shape and caches results
// in the same KV table, so the catalog, match dialog and watch enrichment work
// unchanged. Responses are cached under "tvdb:media:<id>".

// cacheTTL is the response-cache lifetime (setting ttl_tvdb_h, default 24h).
func (c *Client) cacheTTL() time.Duration {
	if h, _ := strconv.Atoi(db.Setting(c.DB, "ttl_tvdb_h")); h > 0 {
		return time.Duration(h) * time.Hour
	}
	return 24 * time.Hour
}

func (c *Client) store(key, payload string) {
	c.DB.Exec(`INSERT INTO anilist_cache (key, payload, fetched_at) VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`, key, payload)
}

// CachedMedia returns a cached TVDB media entry and whether it is still fresh.
func (c *Client) CachedMedia(id int) (m *anilist.Media, fresh bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`,
		fmt.Sprintf("tvdb:media:%d", id)).Scan(&payload, &fetched); err != nil {
		return nil, false
	}
	var out anilist.Media
	if json.Unmarshal([]byte(payload), &out) != nil {
		return nil, false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	return &out, err == nil && time.Since(t) <= c.cacheTTL()
}

// seriesRecord is the subset of TVDB's SeriesBaseRecord used for a media card.
type seriesRecord struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Image      string `json:"image"` // already an absolute artwork URL
	FirstAired string `json:"firstAired"`
	Year       string `json:"year"`
	Overview   string `json:"overview"`
	Status     *struct {
		Name string `json:"name"`
	} `json:"status"`
}

// statusMap translates TVDB status names into the AniList vocabulary the UI
// already knows.
func statusMap(s string) string {
	switch s {
	case "Continuing":
		return "RELEASING"
	case "Ended", "Released":
		return "FINISHED"
	case "Upcoming":
		return "NOT_YET_RELEASED"
	}
	return ""
}

// seriesURL is the stable by-id page on TheTVDB (redirects to the slug URL),
// for cross-checking a match.
func seriesURL(id int) string {
	return fmt.Sprintf("https://thetvdb.com/dereferrer/series/%d", id)
}

func (r seriesRecord) toMedia() anilist.Media {
	var m anilist.Media
	m.ID = r.ID
	m.Title.Romaji = r.Name
	m.CoverImage.Large = r.Image
	m.Format = "TV"
	m.Description = r.Overview
	m.SiteURL = seriesURL(r.ID)
	if r.Status != nil {
		m.Status = statusMap(r.Status.Name)
	}
	year := r.Year
	if year == "" && len(r.FirstAired) >= 4 {
		year = r.FirstAired[:4]
	}
	m.SeasonYear, _ = strconv.Atoi(year)
	return m
}

// Media resolves one TVDB series id into the shared media shape, caching the
// result. Returns a cached entry immediately when fresh.
func (c *Client) Media(ctx context.Context, id int) (*anilist.Media, error) {
	if m, fresh := c.CachedMedia(id); m != nil && fresh {
		return m, nil
	}
	var resp struct {
		Data seriesRecord `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/series/%d", id), &resp); err != nil {
		return nil, err
	}
	m := resp.Data.toMedia()
	// TVDB's default `name` is often the native (Japanese) title for anime. Pull
	// the localized (German, the instance content language TMDB also uses) title
	// as the primary; when it's missing, keep the native name but add the English
	// translation so displayTitle still has a latinized title to fall back to.
	if de := c.translatedName(ctx, id, "deu"); de != "" {
		m.Title.Romaji = de
	} else if en := c.translatedName(ctx, id, "eng"); en != "" {
		m.Title.English = en
	}
	payload, _ := json.Marshal(m)
	c.store(fmt.Sprintf("tvdb:media:%d", id), string(payload))
	return &m, nil
}

// bcp47ToTVDB maps a language's primary subtag (from a BCP-47 tag like "de-DE"
// or a bare "de") to TVDB's ISO 639-2/T 3-letter code. Unknown tags pass
// through unchanged (already a 3-letter code, or best effort).
var bcp47ToTVDB = map[string]string{
	"de": "deu", "en": "eng", "ja": "jpn", "fr": "fra", "es": "spa",
	"it": "ita", "pt": "por", "ru": "rus", "ko": "kor", "zh": "zho",
	"nl": "nld", "pl": "pol", "tr": "tur", "ar": "ara", "cs": "ces",
	"da": "dan", "fi": "fin", "el": "ell", "he": "heb", "hi": "hin",
	"hu": "hun", "nb": "nob", "no": "nor", "ro": "ron", "sk": "slk",
	"sv": "swe", "th": "tha", "uk": "ukr", "vi": "vie",
}

func tvdbLang(bcp47 string) string {
	primary := bcp47
	if i := strings.IndexAny(bcp47, "-_"); i >= 0 {
		primary = bcp47[:i]
	}
	if c, ok := bcp47ToTVDB[strings.ToLower(primary)]; ok {
		return c
	}
	return strings.ToLower(primary)
}

// SeriesTitle returns the series name in the requested language (BCP-47),
// falling back to English then the record's default name. "" only when the
// series can't be fetched at all. Cached per (id, lang) so renames are cheap.
func (c *Client) SeriesTitle(ctx context.Context, id int, bcp47 string) (string, error) {
	key := fmt.Sprintf("tvdb:title:%d:%s", id, bcp47)
	if v, ok := c.cached(key); ok {
		return v, nil
	}
	name := c.translatedName(ctx, id, tvdbLang(bcp47))
	if name == "" && tvdbLang(bcp47) != "eng" {
		name = c.translatedName(ctx, id, "eng")
	}
	if name == "" {
		// last resort: the base record's default name
		if m, err := c.Media(ctx, id); err == nil {
			name = m.Title.Romaji
		}
	}
	if name != "" {
		c.store(key, name)
	}
	return name, nil
}

// tvdbToBCP47 is the inverse of bcp47ToTVDB (built once), for turning TVDB's
// 3-letter codes back into BCP-47 primary subtags.
var tvdbToBCP47 = func() map[string]string {
	m := make(map[string]string, len(bcp47ToTVDB))
	for b, t := range bcp47ToTVDB {
		if _, dup := m[t]; !dup {
			m[t] = b // "nb"/"no" collide on "nob"/"nor"; first wins, both are Norwegian
		}
	}
	return m
}()

// NameTranslations returns every available series title as BCP-47 primary
// subtag → name, in ONE call via the extended record's translations meta.
// Unknown 3-letter codes keep their TVDB code as the locale key.
func (c *Client) NameTranslations(ctx context.Context, id int) (map[string]string, error) {
	var resp struct {
		Data struct {
			Translations struct {
				Names []struct {
					Language string `json:"language"`
					Name     string `json:"name"`
				} `json:"nameTranslations"`
			} `json:"translations"`
		} `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/series/%d/extended?meta=translations&short=true", id), &resp); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, t := range resp.Data.Translations.Names {
		if t.Language == "" || t.Name == "" {
			continue
		}
		loc := tvdbToBCP47[strings.ToLower(t.Language)]
		if loc == "" {
			loc = strings.ToLower(t.Language)
		}
		out[loc] = t.Name
	}
	return out, nil
}

// translation fetches one language's name and overview, "" when absent.
func (c *Client) translation(ctx context.Context, id int, lang3 string) (name, overview string) {
	var resp struct {
		Data struct {
			Name     string `json:"name"`
			Overview string `json:"overview"`
		} `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/series/%d/translations/%s", id, lang3), &resp); err != nil {
		return "", ""
	}
	return resp.Data.Name, resp.Data.Overview
}

func (c *Client) translatedName(ctx context.Context, id int, lang3 string) string {
	name, _ := c.translation(ctx, id, lang3)
	return name
}

// SeriesOverview returns the series description in the requested language
// (BCP-47), falling back to English then "".
func (c *Client) SeriesOverview(ctx context.Context, id int, bcp47 string) string {
	if _, o := c.translation(ctx, id, tvdbLang(bcp47)); o != "" {
		return o
	}
	if _, o := c.translation(ctx, id, "eng"); o != "" {
		return o
	}
	return ""
}

// cached reads a KV cache entry when still fresh.
func (c *Client) cached(key string) (string, bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`, key).
		Scan(&payload, &fetched); err != nil {
		return "", false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	if err != nil || time.Since(t) > c.cacheTTL() {
		return "", false
	}
	return payload, true
}

// searchHit is the subset of a TVDB SearchResult used for match results. The
// alias/translation fields carry the series' other-language titles so a query
// in any language ("Detective Conan", "Meitantei Conan", "Case Closed") can be
// matched, not just the primary (often native) name.
type searchHit struct {
	TVDBID             string            `json:"tvdb_id"`
	Name               string            `json:"name"`
	NameTranslated     string            `json:"name_translated"`
	Aliases            []string          `json:"aliases"`
	Translations       map[string]string `json:"translations"` // lang -> name
	ImageURL           string            `json:"image_url"`
	Year               string            `json:"year"`
	Overview           string            `json:"overview"`
	Overviews          map[string]string `json:"overviews"` // lang -> overview
	OverviewTranslated string            `json:"overview_translated"`
}

// Hit is one search result plus every title it is known by (primary,
// translated, aliases), so callers can match a query against any of them.
type Hit struct {
	Media  anilist.Media
	Titles []string
}

// SearchHits searches TVDB series and returns each result with all its known
// titles for language-agnostic matching. lang (BCP-47) picks the displayed
// title: the localized name becomes Romaji, the native name English, so the UI
// can show "Localized (Original)". Empty lang keeps the native name.
func (c *Client) SearchHits(ctx context.Context, query, lang string) ([]Hit, error) {
	var resp struct {
		Data []searchHit `json:"data"`
	}
	q := url.Values{"query": {query}, "type": {"series"}}
	if err := c.get(ctx, "/search?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	want := ""
	if lang != "" {
		want = tvdbLang(lang)
	}
	out := make([]Hit, 0, len(resp.Data))
	for _, h := range resp.Data {
		id := ParseID(h.TVDBID)
		if id == 0 {
			continue
		}
		var m anilist.Media
		m.ID = id
		// display: localized (user language) as the primary, native in parens
		localized := ""
		if want != "" {
			localized = h.Translations[want]
		}
		if localized == "" {
			localized = h.NameTranslated
		}
		if localized != "" && localized != h.Name {
			m.Title.Romaji, m.Title.English = localized, h.Name
		} else {
			m.Title.Romaji = h.Name
		}
		m.CoverImage.Large = h.ImageURL
		m.Format = "TV"
		m.Description = h.Overview
		if want != "" {
			if o := h.Overviews[want]; o != "" {
				m.Description = o
			} else if h.OverviewTranslated != "" {
				m.Description = h.OverviewTranslated
			}
		}
		m.SeasonYear, _ = strconv.Atoi(h.Year)
		m.SiteURL = seriesURL(id)

		titles := []string{h.Name, h.NameTranslated}
		titles = append(titles, h.Aliases...)
		for _, v := range h.Translations {
			titles = append(titles, v)
		}
		out = append(out, Hit{Media: m, Titles: titles})
	}
	return out, nil
}

// SearchMedia searches TVDB series and maps hits into media cards (native
// titles). For localized picker results use SearchHits with a language.
func (c *Client) SearchMedia(ctx context.Context, query string) ([]anilist.Media, error) {
	hits, err := c.SearchHits(ctx, query, "")
	if err != nil {
		return nil, err
	}
	out := make([]anilist.Media, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.Media)
	}
	return out, nil
}
