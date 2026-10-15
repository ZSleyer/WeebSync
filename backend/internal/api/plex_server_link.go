package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/plex"
	"github.com/ch4d1/weebsync/internal/secret"
)

// Connecting the Plex server by signing in with plex.tv instead of pasting a
// URL and a token: the official flow is a PIN the admin claims on plex.tv, the
// account's server list from plex.tv, and per server its own token and its
// addresses. The account token is held here only until a server is picked;
// what is stored is the server's token and the address that answered.

const plexServerFlow = "plex-server"

// plexServerSignins holds, per claimed PIN, the account's servers until the
// admin picks one. In memory and short-lived, like the PIN itself.
var plexServerSignins = struct {
	sync.Mutex
	m map[string]plexServerSignin
}{m: map[string]plexServerSignin{}}

type plexServerSignin struct {
	servers []plex.Resource
	expires time.Time
}

// plexServerChoice is one server the signed-in account may use.
type plexServerChoice struct {
	ID    string `json:"id"` // the server's machine identifier
	Name  string `json:"name"`
	Owned bool   `json:"owned"`
	Local bool   `json:"local"` // it lists an address on the local network
}

// plexServerPollResponse is the state of a server sign-in: waiting, or done
// with the servers to pick from.
type plexServerPollResponse struct {
	Linked  bool               `json:"linked"`
	User    string             `json:"user,omitempty"`
	Servers []plexServerChoice `json:"servers"`
}

// handlePlexServerLinkStart begins signing in with plex.tv to connect a server.
//
//	@Summary		Start Plex server sign-in
//	@Description	Create a plex.tv PIN and return the page the admin signs in on, to connect a Plex server without pasting a token.
//	@Tags			Settings
//	@Produce		json
//	@Success		200	{object}	plexLinkResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/plex/server/link/start [post]
func (s *Server) handlePlexServerLinkStart(w http.ResponseWriter, r *http.Request) {
	s.startPlexPin(w, r, plexServerFlow)
}

// handlePlexServerLinkPoll reports whether the PIN was claimed and, once it
// is, lists the account's servers.
//
//	@Summary		Poll Plex server sign-in
//	@Tags			Settings
//	@Produce		json
//	@Param			id	query		string	true	"PIN id from link/start"
//	@Success		200	{object}	plexServerPollResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/plex/server/link/poll [get]
func (s *Server) handlePlexServerLinkPoll(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := r.URL.Query().Get("id")
	if id == "" || !ownsLinkFlow(plexServerFlow, id, u.ID) {
		writeErr(w, http.StatusNotFound, "sign-in not found")
		return
	}
	token, err := s.plexPinToken(id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv unreachable")
		return
	}
	if token == "" {
		writeJSON(w, http.StatusOK, plexServerPollResponse{Servers: []plexServerChoice{}}) // still waiting
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	servers, err := plex.Resources(ctx, netguard.Client(20*time.Second), s.plexClientID(), token)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv did not list the servers")
		return
	}
	plexServerSignins.Lock()
	plexServerSignins.m[id] = plexServerSignin{servers: servers, expires: time.Now().Add(10 * time.Minute)}
	plexServerSignins.Unlock()
	out := plexServerPollResponse{Linked: true, User: s.plexTVUser(token), Servers: []plexServerChoice{}}
	for _, sv := range servers {
		c := plexServerChoice{ID: sv.ClientIdentifier, Name: sv.Name, Owned: sv.Owned}
		for _, cn := range sv.Connections {
			c.Local = c.Local || cn.Local
		}
		out.Servers = append(out.Servers, c)
	}
	writeJSON(w, http.StatusOK, out)
}

// plexServerConnectRequest picks a server of a finished sign-in.
type plexServerConnectRequest struct {
	ID     string `json:"id"`     // the PIN id of the sign-in
	Server string `json:"server"` // the server's machine identifier
}

// plexServerConnectResponse names the server and the address it answered on.
type plexServerConnectResponse struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// handlePlexServerConnect stores the chosen server: the first of its addresses
// that answers as that very server (local first, relay last), and its token.
//
//	@Summary		Connect a Plex server
//	@Tags			Settings
//	@Accept			json
//	@Produce		json
//	@Param			body	body		plexServerConnectRequest	true	"Sign-in and server"
//	@Success		200		{object}	plexServerConnectResponse
//	@Failure		404		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/plex/server/connect [post]
func (s *Server) handlePlexServerConnect(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in plexServerConnectRequest
	if !readJSON(w, r, &in) {
		return
	}
	if !ownsLinkFlow(plexServerFlow, in.ID, u.ID) {
		writeErr(w, http.StatusNotFound, "sign-in not found")
		return
	}
	plexServerSignins.Lock()
	signin, ok := plexServerSignins.m[in.ID]
	plexServerSignins.Unlock()
	var server *plex.Resource
	if ok && time.Now().Before(signin.expires) {
		for i := range signin.servers {
			if signin.servers[i].ClientIdentifier == in.Server {
				server = &signin.servers[i]
			}
		}
	}
	if server == nil {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	addr, err := server.Reach(netguard.Client(5*time.Second), s.plexClientID())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "none of the server's addresses answered")
		return
	}
	enc, err := secret.EncodeSetting(server.AccessToken)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt error")
		return
	}
	db.SetSetting(s.DB, "plex_url", addr)
	db.SetSetting(s.DB, "plex_token", enc)
	db.SetSetting(s.DB, "plex_server_name", server.Name)
	db.SetSetting(s.DB, "plex_auth", "signin") // no prompt to sign in any more
	plexServerSignins.Lock()
	delete(plexServerSignins.m, in.ID)
	plexServerSignins.Unlock()
	forgetLinkFlow(plexServerFlow, in.ID)
	slog.Info("plex server connected", "server", logSafe(server.Name), "url", logSafe(addr))
	go s.refreshPlexRoots() // the libraries and their roots, as after a settings change
	writeJSON(w, http.StatusOK, plexServerConnectResponse{Name: server.Name, URL: addr})
}
