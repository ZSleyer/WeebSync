// Package plex is a minimal read-only client for the Plex Media Server API,
// just enough to list show libraries and locate series folders.
package plex

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	URL   string // e.g. https://plex.example.com
	Token string
	HTTP  *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{URL: strings.TrimRight(baseURL, "/"), Token: token,
		HTTP: &http.Client{Timeout: 15 * time.Second}}
}

type Section struct {
	Key   string `json:"key"`
	Type  string `json:"type"` // movie | show | artist
	Title string `json:"title"`
}

type Show struct {
	RatingKey     string `json:"ratingKey"`
	Title         string `json:"title"`
	OriginalTitle string `json:"originalTitle"`
	Year          int    `json:"year"`
	LeafCount     int    `json:"leafCount"`  // episodes present
	ChildCount    int    `json:"childCount"` // seasons present
	Locations     []string
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

func (c *Client) Sections() ([]Section, error) {
	var resp struct {
		MediaContainer struct {
			Directory []Section `json:"Directory"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/sections", &resp); err != nil {
		return nil, err
	}
	return resp.MediaContainer.Directory, nil
}

type rawShow struct {
	Show
	Location []struct {
		Path string `json:"path"`
	} `json:"Location"`
}

func (r rawShow) toShow() Show {
	s := r.Show
	for _, l := range r.Location {
		s.Locations = append(s.Locations, l.Path)
	}
	return s
}

// Shows lists every show of a section (title, year, episode/season counts).
func (c *Client) Shows(sectionKey string) ([]Show, error) {
	var resp struct {
		MediaContainer struct {
			Metadata []rawShow `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/library/sections/"+url.PathEscape(sectionKey)+"/all", &resp); err != nil {
		return nil, err
	}
	shows := make([]Show, 0, len(resp.MediaContainer.Metadata))
	for _, m := range resp.MediaContainer.Metadata {
		shows = append(shows, m.toShow())
	}
	return shows, nil
}

// MachineID returns the server's machine identifier, needed for Plex Web
// deep links.
func (c *Client) MachineID() (string, error) {
	var resp struct {
		MediaContainer struct {
			MachineIdentifier string `json:"machineIdentifier"`
		} `json:"MediaContainer"`
	}
	if err := c.get("/", &resp); err != nil {
		return "", err
	}
	return resp.MediaContainer.MachineIdentifier, nil
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
