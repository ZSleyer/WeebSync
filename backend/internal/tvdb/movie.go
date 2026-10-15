package tvdb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// Films on TVDB. They are numbered apart from series, so they cache under a
// key of their own ("tvdb:movie:media:<id>") and the catalogue tags them
// "tvdb:movie".

// movieURL is the stable by-id page of a film on TheTVDB; its own page URL is
// a slug.
func movieURL(id int) string {
	return fmt.Sprintf("https://thetvdb.com/dereferrer/movie/%d", id)
}

// movieRecord is the part of TVDB's extended movie record a media card uses.
type movieRecord struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	Year   string `json:"year"`
	Status *struct {
		Name string `json:"name"`
	} `json:"status"`
	Genres []struct {
		Name string `json:"name"`
	} `json:"genres"`
	FirstRelease *struct {
		Date string `json:"date"`
	} `json:"first_release"`
}

func (r movieRecord) toMedia() anilist.Media {
	var m anilist.Media
	m.ID = r.ID
	m.Title.Romaji = r.Name
	m.CoverImage.Large = r.Image
	m.Format = "MOVIE"
	m.Episodes = 1
	m.SiteURL = movieURL(r.ID)
	if r.Status != nil {
		m.Status = statusMap(r.Status.Name)
	}
	m.SeasonYear, _ = strconv.Atoi(r.Year)
	if r.FirstRelease != nil {
		if t, err := time.Parse("2006-01-02", r.FirstRelease.Date); err == nil {
			m.StartDate = anilist.Date(t.Year(), int(t.Month()), t.Day())
			if m.SeasonYear == 0 {
				m.SeasonYear = t.Year()
			}
		}
	}
	for _, g := range r.Genres {
		m.Genres = append(m.Genres, g.Name)
	}
	m.Schema = anilist.MediaSchema
	return m
}

// CachedMovie returns a cached TVDB film and whether it is still fresh.
func (c *Client) CachedMovie(id int) (m *anilist.Media, fresh bool) {
	var payload, fetched string
	if err := c.DB.QueryRow(`SELECT payload, fetched_at FROM anilist_cache WHERE key = ?`,
		fmt.Sprintf("tvdb:movie:media:%d", id)).Scan(&payload, &fetched); err != nil {
		return nil, false
	}
	var out anilist.Media
	if json.Unmarshal([]byte(payload), &out) != nil {
		return nil, false
	}
	t, err := time.Parse("2006-01-02 15:04:05", fetched)
	return &out, err == nil && time.Since(t) <= c.cacheTTL()
}

// Movie resolves one TVDB film into the shared media shape, cached. The name
// is the German one where TVDB has it, else English, like a series'.
func (c *Client) Movie(ctx context.Context, id int) (*anilist.Media, error) {
	if m, fresh := c.CachedMovie(id); m != nil && fresh {
		return m, nil
	}
	var resp struct {
		Data movieRecord `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/movies/%d/extended?short=true", id), &resp); err != nil {
		return nil, err
	}
	m := resp.Data.toMedia()
	// the base name is the original one (Japanese for an anime film): German
	// first, as for a series, else the English name beside it
	de, deOverview := c.movieTranslation(ctx, id, "deu")
	en, enOverview := c.movieTranslation(ctx, id, "eng")
	switch {
	case de != "":
		m.Title.Romaji = de
	case en != "":
		m.Title.English = en
	}
	m.Description = firstNonEmpty(deOverview, enOverview)
	m.Descriptions = overviews(deOverview, enOverview)
	payload, _ := json.Marshal(m)
	c.store(fmt.Sprintf("tvdb:movie:media:%d", id), string(payload))
	return &m, nil
}

// Extras is what the series page shows beside the record: the cast (TVDB
// files voice and screen actors alike as "Actor"), the outbound links and the
// other names it goes by.
type Extras struct {
	Characters []anilist.Character
	Links      []anilist.ExternalLink
	Synonyms   []string
}

// character is one cast entry of an extended record.
type character struct {
	Name       string `json:"name"`
	PersonName string `json:"personName"`
	Image      string `json:"image"`
	PeopleType string `json:"peopleType"`
	Sort       int    `json:"sort"`
	IsFeatured bool   `json:"isFeatured"`
}

// remoteLinks turns TVDB's remote ids into links; the types without a page
// to open (EIDR, TMS) are left out.
var remoteLinks = map[int]func(id string) (site, url string){
	2:  func(id string) (string, string) { return "IMDb", "https://www.imdb.com/title/" + id },
	4:  func(id string) (string, string) { return "Official Site", id },
	5:  func(id string) (string, string) { return "Facebook", "https://www.facebook.com/" + id },
	6:  func(id string) (string, string) { return "X", "https://x.com/" + id },
	9:  func(id string) (string, string) { return "Instagram", "https://www.instagram.com/" + id },
	10: func(id string) (string, string) { return "TMDB", "https://www.themoviedb.org/movie/" + id },
	12: func(id string) (string, string) { return "TMDB", "https://www.themoviedb.org/tv/" + id },
	24: func(id string) (string, string) { return "Wikipedia", id },
}

// Extras reads the cast, links and aliases of a series (movie false) or a
// film from the full extended record, cached like the record itself.
func (c *Client) Extras(ctx context.Context, id int, movie bool) (Extras, error) {
	kind := "series"
	if movie {
		kind = "movies"
	}
	key := fmt.Sprintf("tvdb:extras:%s:%d", kind, id)
	var x Extras
	if p, ok := c.cached(key); ok && json.Unmarshal([]byte(p), &x) == nil {
		return x, nil
	}
	var resp struct {
		Data struct {
			Characters []character `json:"characters"`
			RemoteIDs  []struct {
				ID   string `json:"id"`
				Type int    `json:"type"`
			} `json:"remoteIds"`
			Aliases []struct {
				Name string `json:"name"`
			} `json:"aliases"`
		} `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/%s/%d/extended", kind, id), &resp); err != nil {
		return Extras{}, err
	}
	x = Extras{Characters: []anilist.Character{}, Links: []anilist.ExternalLink{}, Synonyms: []string{}}
	chars := resp.Data.Characters
	// the main cast first, in TVDB's own order
	slices.SortStableFunc(chars, func(a, b character) int {
		if a.IsFeatured != b.IsFeatured {
			if a.IsFeatured {
				return -1
			}
			return 1
		}
		return a.Sort - b.Sort
	})
	for _, ch := range chars {
		if ch.PeopleType != "Actor" || ch.Name == "" || len(x.Characters) == 12 {
			continue
		}
		x.Characters = append(x.Characters, anilist.Character{Name: ch.Name, Image: ch.Image, ImageLarge: ch.Image, VoiceActor: ch.PersonName})
	}
	for _, r := range resp.Data.RemoteIDs {
		if f, ok := remoteLinks[r.Type]; ok && r.ID != "" {
			site, u := f(r.ID)
			x.Links = append(x.Links, anilist.ExternalLink{Site: site, URL: u, Type: "INFO"})
		}
	}
	for _, a := range resp.Data.Aliases {
		if a.Name != "" && !slices.Contains(x.Synonyms, a.Name) {
			x.Synonyms = append(x.Synonyms, a.Name)
		}
	}
	if b, err := json.Marshal(x); err == nil {
		c.store(key, string(b))
	}
	return x, nil
}

// RemoteID translates another catalogue's id (an IMDb "tt…" or a TMDB number)
// into TVDB's: the series and the film that carry it, 0 for none. A TMDB
// number can name a series and an unrelated film at once - TMDB numbers its
// tv and movies apart - so the caller picks the one it is looking for.
// Cached, as the answer only changes when TVDB's editors relink.
func (c *Client) RemoteID(ctx context.Context, remoteID string) (series, movie int, err error) {
	key := "tvdb:remoteid:" + remoteID
	var hit struct{ Series, Movie int }
	if p, ok := c.cached(key); ok && json.Unmarshal([]byte(p), &hit) == nil {
		return hit.Series, hit.Movie, nil
	}
	var resp struct {
		Data []struct {
			Series *struct {
				ID int `json:"id"`
			} `json:"series"`
			Movie *struct {
				ID int `json:"id"`
			} `json:"movie"`
		} `json:"data"`
	}
	if err := c.get(ctx, "/search/remoteid/"+url.PathEscape(remoteID), &resp); err != nil {
		return 0, 0, err
	}
	for _, d := range resp.Data {
		if d.Series != nil && hit.Series == 0 {
			hit.Series = d.Series.ID
		}
		if d.Movie != nil && hit.Movie == 0 {
			hit.Movie = d.Movie.ID
		}
	}
	if b, err := json.Marshal(hit); err == nil {
		c.store(key, string(b))
	}
	return hit.Series, hit.Movie, nil
}

// movieTranslation is a film's name and overview in one language, empty when
// TVDB has none.
func (c *Client) movieTranslation(ctx context.Context, id int, lang3 string) (name, overview string) {
	var resp struct {
		Data struct {
			Name     string `json:"name"`
			Overview string `json:"overview"`
		} `json:"data"`
	}
	if err := c.get(ctx, fmt.Sprintf("/movies/%d/translations/%s", id, lang3), &resp); err != nil {
		return "", ""
	}
	return resp.Data.Name, resp.Data.Overview
}
