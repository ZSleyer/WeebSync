package plex

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Signing in with a plex.tv account instead of pasting a token. The account
// token only talks to plex.tv; each server it may use comes with a token of
// its own and a list of addresses (official API docs, "Authenticating with
// Plex"), and that pair is what a client keeps.

// Resource is one Plex Media Server the account may use.
type Resource struct {
	Name             string `json:"name"`
	ClientIdentifier string `json:"clientIdentifier"` // the server's machineIdentifier
	Provides         string `json:"provides"`
	Owned            bool   `json:"owned"`
	AccessToken      string `json:"accessToken"` // the token for this server, not the account
	HTTPSRequired    bool   `json:"httpsRequired"`
	Connections      []struct {
		URI      string `json:"uri"`
		Protocol string `json:"protocol"`
		Address  string `json:"address"`
		Port     int    `json:"port"`
		Local    bool   `json:"local"`
		Relay    bool   `json:"relay"`
		IPv6     bool   `json:"IPv6"`
	} `json:"connections"`
}

// IsServer reports whether the resource is a media server (an account also
// lists its players).
func (r Resource) IsServer() bool {
	return strings.Contains(r.Provides, "server")
}

// Resources lists the account's servers from plex.tv.
func Resources(ctx context.Context, hc *http.Client, clientID, accountToken string) ([]Resource, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", Product)
	req.Header.Set("X-Plex-Client-Identifier", clientID)
	req.Header.Set("X-Plex-Token", accountToken)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errStatus(resp.StatusCode)
	}
	var all []Resource
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&all); err != nil {
		return nil, err
	}
	servers := all[:0]
	for _, r := range all {
		if r.IsServer() {
			servers = append(servers, r)
		}
	}
	return servers, nil
}

// Candidates orders the addresses to try: local before remote and relay last
// (the docs: relay bandwidth is limited), https before plain http. A local
// address is also tried as plain http on its own IP, as a *.plex.direct name
// does not resolve where DNS guards against rebinding - unless the server
// insists on https.
func (r Resource) Candidates() []string {
	var out []string
	add := func(u string) {
		for _, have := range out {
			if have == u {
				return
			}
		}
		out = append(out, u)
	}
	for _, pass := range []struct{ local, relay bool }{{true, false}, {false, false}, {false, true}} {
		for _, c := range r.Connections {
			if c.Local != pass.local || c.Relay != pass.relay || c.IPv6 {
				continue
			}
			add(c.URI)
			if c.Local && !r.HTTPSRequired && c.Address != "" && c.Port != 0 {
				add(fmt.Sprintf("http://%s:%d", c.Address, c.Port))
			}
		}
	}
	return out
}

// Reach finds the first address that answers as this very server - its
// /identity carries the machineIdentifier plex.tv listed - so a stale or
// foreign address is never kept. Each try gets a few seconds.
func (r Resource) Reach(hc *http.Client, clientID string) (string, error) {
	for _, u := range r.Candidates() {
		c := &Client{URL: strings.TrimRight(u, "/"), Token: r.AccessToken, ClientID: clientID,
			HTTP: &http.Client{Timeout: 5 * time.Second, Transport: hc.Transport}}
		id, err := c.Identity()
		if err == nil && id.MachineIdentifier == r.ClientIdentifier {
			return c.URL, nil
		}
	}
	return "", fmt.Errorf("plex: no address of %q answered", r.Name)
}
