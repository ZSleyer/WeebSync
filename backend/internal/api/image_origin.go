package api

import (
	"net/url"
	"strings"
)

// imageOrigin rebuilds a poster or banner URL on the constant origin of one
// of the providers' image hosts. The URL reached the server from outside (a
// query parameter, a provider's answer), so only its path is taken over; the
// scheme, host and port never come from it. ok is false for any other host,
// for userinfo or a port, and for a query or fragment (the providers' image
// paths carry none). anilistOnly narrows it to AniList's image host.
func imageOrigin(u string, anilistOnly bool) (string, bool) {
	p, err := url.Parse(u)
	if err != nil || p.Scheme != "https" || p.User != nil || p.Port() != "" || p.RawQuery != "" || p.Fragment != "" {
		return "", false
	}
	path := strings.TrimPrefix(p.EscapedPath(), "/")
	if path == "" {
		return "", false
	}
	switch p.Host {
	case "s4.anilist.co":
		return "https://s4.anilist.co/" + path, true
	case "image.tmdb.org":
		if !anilistOnly {
			return "https://image.tmdb.org/" + path, true
		}
	case "artworks.thetvdb.com":
		if !anilistOnly {
			return "https://artworks.thetvdb.com/" + path, true
		}
	}
	return "", false
}
