package jellyfin

import (
	"errors"
	"net/http"
	"net/url"
)

// Quick Connect is Jellyfin's counterpart to the plex.tv PIN: the app asks for
// a code, the user enters it in a Jellyfin app they are signed in to, and the
// app then trades the secret for that user's access token. The server must
// have Quick Connect enabled (Dashboard, General).

// ErrQuickConnectOff is a server with Quick Connect switched off.
var ErrQuickConnectOff = errors.New("quick connect is disabled on this server")

// QuickConnect is one pending sign-in: Code is shown to the user, Secret stays
// with the app.
type QuickConnect struct {
	Secret        string `json:"Secret"`
	Code          string `json:"Code"`
	Authenticated bool   `json:"Authenticated"`
}

// QuickConnectStart asks the server for a code. c needs no token.
func (c *Client) QuickConnectStart() (QuickConnect, error) {
	var on bool
	if err := c.get("/QuickConnect/Enabled", &on); err != nil {
		return QuickConnect{}, err
	}
	if !on {
		return QuickConnect{}, ErrQuickConnectOff
	}
	var qc QuickConnect
	err := c.Do(http.MethodPost, "/QuickConnect/Initiate", nil, &qc)
	return qc, err
}

// QuickConnectToken is "" while the code is not entered yet, and the user's
// access token once it is.
func (c *Client) QuickConnectToken(secret string) (string, User, error) {
	var qc QuickConnect
	if err := c.get("/QuickConnect/Connect?secret="+url.QueryEscape(secret), &qc); err != nil {
		return "", User{}, err
	}
	if !qc.Authenticated {
		return "", User{}, nil
	}
	var res struct {
		AccessToken string `json:"AccessToken"`
		User        User   `json:"User"`
	}
	if err := c.Do(http.MethodPost, "/Users/AuthenticateWithQuickConnect", map[string]string{"Secret": secret}, &res); err != nil {
		return "", User{}, err
	}
	return res.AccessToken, res.User, nil
}

// Favorites lists the token user's favourite series and movies, Jellyfin's
// nearest thing to a watchlist (it has none).
func (c *Client) Favorites() ([]Favorite, error) {
	me, err := c.Me()
	if err != nil {
		return nil, err
	}
	q := url.Values{"userId": {me.ID}, "recursive": {"true"}, "isFavorite": {"true"},
		"includeItemTypes": {"Series,Movie"}, "fields": {"ProviderIds,ProductionYear"}}
	var page itemPage
	if err := c.get("/Items?"+q.Encode(), &page); err != nil {
		return nil, err
	}
	out := make([]Favorite, 0, len(page.Items))
	for _, it := range page.Items {
		f := Favorite{Title: it.Name, Year: it.ProductionYear, Type: "show",
			TVDB: providerID(it.ProviderIds, "Tvdb"), TMDB: providerID(it.ProviderIds, "Tmdb")}
		if it.Type == "Movie" {
			f.Type = "movie"
		}
		out = append(out, f)
	}
	return out, nil
}

// Favorite is one favourited item, shaped like a plex.tv watchlist entry.
type Favorite struct {
	Title string
	Year  int
	Type  string // show | movie
	TVDB  int
	TMDB  int
}
