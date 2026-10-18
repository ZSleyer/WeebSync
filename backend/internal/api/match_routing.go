package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/ch4d1/weebsync/internal/db"
)

// Match routing: which providers matching asks, and for "automatic" catalog
// marks and the match hints in which order.
//
//   - Three switches, one per provider, turn a provider off for matching
//     altogether. With all three off, nothing is matched (the sweep, the
//     catalog and the auto-sync make no matching call). They only concern
//     matching: the calendar, airings and discovery keep using AniList.
//   - Four ordered lists - anime series, anime films, series (live action,
//     western animation), films - each naming the providers in the order they
//     are asked, with an on/off switch each. A list with nothing on matches
//     nothing for that kind of folder.
//
// An "automatic" mark picks the list from the folder (anime or not, series or
// film; see autoAnime and autoMovie). The marks of any other kind keep their
// one provider, switched off only by the provider switch. Hints use the lists
// for the non-anime kinds.

const matchRoutingKey = "match_routing"

// routeProviders are the providers a routing list may name.
var routeProviders = []string{"anilist", "tvdb", "tmdb"}

// routeEntry is one provider of a routing list.
type routeEntry struct {
	Provider string `json:"provider" enums:"anilist,tvdb,tmdb"`
	Enabled  bool   `json:"enabled"`
}

// routeSwitches turns a provider off for matching.
type routeSwitches struct {
	Anilist bool `json:"anilist"`
	Tvdb    bool `json:"tvdb"`
	Tmdb    bool `json:"tmdb"`
}

// matchRouting is the stored routing.
type matchRouting struct {
	Providers   routeSwitches `json:"providers"`
	AnimeSeries []routeEntry  `json:"animeSeries"`
	AnimeMovie  []routeEntry  `json:"animeMovie"`
	Series      []routeEntry  `json:"series"`
	Movie       []routeEntry  `json:"movie"`
}

// clone copies the lists, so decoding a body into the copy leaves the original alone.
func (r matchRouting) clone() matchRouting {
	r.AnimeSeries = slices.Clone(r.AnimeSeries)
	r.AnimeMovie = slices.Clone(r.AnimeMovie)
	r.Series = slices.Clone(r.Series)
	r.Movie = slices.Clone(r.Movie)
	return r
}

// defaultRouting: an anime is looked up on AniList first, then on TVDB (series)
// or TMDB (films); a series or film that is no anime is not asked of AniList.
func defaultRouting() matchRouting {
	mk := func(on bool, p ...string) []routeEntry {
		out := make([]routeEntry, 0, len(routeProviders))
		for _, x := range p {
			out = append(out, routeEntry{Provider: x, Enabled: on || x != "anilist"})
		}
		return out
	}
	return matchRouting{
		Providers:   routeSwitches{Anilist: true, Tvdb: true, Tmdb: true},
		AnimeSeries: mk(true, "anilist", "tvdb", "tmdb"),
		AnimeMovie:  mk(true, "anilist", "tmdb", "tvdb"),
		Series:      mk(false, "anilist", "tvdb", "tmdb"),
		Movie:       mk(false, "anilist", "tmdb", "tvdb"),
	}
}

// validateRouting refuses a list that names an unknown provider, one twice, or
// leaves one out. A list with nothing switched on is fine: it matches nothing.
func validateRouting(r matchRouting) error {
	for _, l := range []struct {
		name string
		list []routeEntry
	}{{"animeSeries", r.AnimeSeries}, {"animeMovie", r.AnimeMovie}, {"series", r.Series}, {"movie", r.Movie}} {
		seen := map[string]bool{}
		for _, e := range l.list {
			if !slices.Contains(routeProviders, e.Provider) {
				return fmt.Errorf("%s: unknown provider %q", l.name, e.Provider)
			}
			if seen[e.Provider] {
				return fmt.Errorf("%s: %s listed twice", l.name, e.Provider)
			}
			seen[e.Provider] = true
		}
		if len(seen) != len(routeProviders) {
			return fmt.Errorf("%s: every provider must be listed", l.name)
		}
	}
	return nil
}

// routing reads the stored routing; no value, or one that no longer validates,
// reads as the defaults.
func (s *Server) routing() matchRouting {
	raw := strings.TrimSpace(db.Setting(s.DB, matchRoutingKey))
	if raw == "" {
		return defaultRouting()
	}
	r := defaultRouting() // a stored value without a list keeps that list's default
	if err := json.Unmarshal([]byte(raw), &r); err != nil || validateRouting(r) != nil {
		slog.Warn("match routing setting is invalid, using the defaults")
		return defaultRouting()
	}
	return r
}

// providerUsable reports whether matching may ask a provider: its switch is on
// and, for TVDB and TMDB, it has a key. AniList needs none.
func (s *Server) providerUsable(r matchRouting, provider string) bool {
	switch provider {
	case "anilist":
		return r.Providers.Anilist
	case "tvdb":
		return r.Providers.Tvdb && s.Tvdb != nil && s.Tvdb.Enabled()
	case "tmdb":
		return r.Providers.Tmdb && s.Tmdb != nil && s.Tmdb.Enabled()
	}
	return false
}

// matchingOff reports whether no provider may be asked: nothing is matched.
func (s *Server) matchingOff() bool {
	r := s.routing()
	return !r.Providers.Anilist && !r.Providers.Tvdb && !r.Providers.Tmdb
}

// sourceProvider names the provider a match source belongs to.
func sourceProvider(source string) string {
	switch {
	case source == "anilist" || source == mangaSource:
		return "anilist"
	case strings.HasPrefix(source, "tmdb:"):
		return "tmdb"
	case strings.HasPrefix(source, "tvdb"):
		return "tvdb"
	}
	return ""
}

// scopeMatchable reports whether a catalog mark's provider is switched on for
// matching. An automatic mark has none of its own: it asks the lists, which
// may be empty for a folder, so it is matchable while any provider is on.
func (s *Server) scopeMatchable(scope string) bool {
	r := s.routing()
	if scope == scopeAuto {
		return r.Providers.Anilist || r.Providers.Tvdb || r.Providers.Tmdb
	}
	switch sourceProvider(sourceForScope(scope)) {
	case "anilist":
		return r.Providers.Anilist
	case "tvdb":
		return r.Providers.Tvdb
	case "tmdb":
		return r.Providers.Tmdb
	}
	return true
}

// providerSequence lists the providers an automatic mark asks for a folder of
// the given kind, in order: the ones switched on in the list and usable.
func (s *Server) providerSequence(anime, movie bool) []string {
	r := s.routing()
	list := r.Series
	switch {
	case anime && movie:
		list = r.AnimeMovie
	case anime:
		list = r.AnimeSeries
	case movie:
		list = r.Movie
	}
	var out []string
	for _, e := range list {
		if e.Enabled && s.providerUsable(r, e.Provider) {
			out = append(out, e.Provider)
		}
	}
	return out
}
