package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/jellyfin"
	"github.com/ch4d1/weebsync/internal/secret"
)

// Jellyfin sign-in by Quick Connect, the counterpart of the plex.tv PIN, for
// both things Plex signs in for: the server connection (admin) and a user's own
// account, whose favourites stand in for the plex.tv watchlist. The Quick
// Connect secret never leaves the server; the browser gets an id and the code.

const (
	jellyfinServerFlow  = "jellyfin-server"
	jellyfinAccountFlow = "jellyfin"
)

var jellyfinSignins = struct {
	sync.Mutex
	m map[string]jellyfinSignin
}{m: map[string]jellyfinSignin{}}

type jellyfinSignin struct {
	url, secret string
	expires     time.Time // Jellyfin drops a request after ten minutes too
}

// jellyfinLinkRequest names the server for a server sign-in; an account
// sign-in always goes to the configured one.
type jellyfinLinkRequest struct {
	URL string `json:"url"`
}

// jellyfinLinkResponse is the code to enter in Jellyfin (Settings, Quick
// Connect) and the id to poll with.
type jellyfinLinkResponse struct {
	ID   string `json:"id"`
	Code string `json:"code"`
}

// jellyfinPollResponse is a sign-in still waiting, or done as that user.
type jellyfinPollResponse struct {
	Linked bool   `json:"linked"`
	User   string `json:"user,omitempty"`
}

// jellyfinDevice is the DeviceId a token is issued to and used under. Jellyfin
// keeps one session per device and a new sign-in ends the old one, so the
// server connection and each user's account need ids of their own: one shared
// id let a user's favourites link log the server connection out.
func (s *Server) jellyfinDevice(kind string, userID int64) string {
	if kind == jellyfinServerFlow {
		return s.plexClientID() + "-server"
	}
	return s.plexClientID() + "-user" + strconv.FormatInt(userID, 10)
}

func (s *Server) startJellyfinLink(w http.ResponseWriter, r *http.Request, kind, base string) {
	u := auth.UserFrom(r.Context())
	c := jellyfin.New(base, "")
	c.DeviceID = s.jellyfinDevice(kind, u.ID)
	qc, err := c.QuickConnectStart()
	if errors.Is(err, jellyfin.ErrQuickConnectOff) {
		writeErr(w, http.StatusConflict, "Quick Connect is disabled on this Jellyfin server")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Jellyfin unreachable")
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	id := hex.EncodeToString(b)
	jellyfinSignins.Lock()
	now := time.Now()
	for k, sg := range jellyfinSignins.m {
		if now.After(sg.expires) {
			delete(jellyfinSignins.m, k)
		}
	}
	jellyfinSignins.m[id] = jellyfinSignin{url: base, secret: qc.Secret, expires: now.Add(10 * time.Minute)}
	jellyfinSignins.Unlock()
	rememberLinkFlow(kind, id, u.ID)
	writeJSON(w, http.StatusOK, jellyfinLinkResponse{ID: id, Code: qc.Code})
}

// pollJellyfinLink returns the token once the code was entered; "" while
// waiting. ok=false means the reply was already written.
func (s *Server) pollJellyfinLink(w http.ResponseWriter, r *http.Request, kind string) (sg jellyfinSignin, token string, user jellyfin.User, ok bool) {
	u := auth.UserFrom(r.Context())
	id := r.URL.Query().Get("id")
	jellyfinSignins.Lock()
	sg, found := jellyfinSignins.m[id]
	jellyfinSignins.Unlock()
	if id == "" || !found || !ownsLinkFlow(kind, id, u.ID) {
		writeErr(w, http.StatusNotFound, "sign-in not found")
		return sg, "", user, false
	}
	c := jellyfin.New(sg.url, "")
	c.DeviceID = s.jellyfinDevice(kind, u.ID)
	token, user, err := c.QuickConnectToken(sg.secret)
	if err != nil {
		// Jellyfin forgets a request after ten minutes and answers 404
		writeErr(w, http.StatusBadGateway, "Jellyfin did not confirm the sign-in")
		return sg, "", user, false
	}
	if token != "" {
		jellyfinSignins.Lock()
		delete(jellyfinSignins.m, id)
		jellyfinSignins.Unlock()
		forgetLinkFlow(kind, id)
	}
	return sg, token, user, true
}

// handleJellyfinServerLinkStart begins connecting a Jellyfin server.
//
//	@Summary		Start Jellyfin server sign-in
//	@Description	Ask the Jellyfin server for a Quick Connect code; an administrator enters it in Jellyfin to connect the server without an API key.
//	@Tags			Settings
//	@Accept			json
//	@Produce		json
//	@Param			body	body		jellyfinLinkRequest	true	"Server address"
//	@Success		200		{object}	jellyfinLinkResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		409		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/jellyfin/server/link/start [post]
func (s *Server) handleJellyfinServerLinkStart(w http.ResponseWriter, r *http.Request) {
	var in jellyfinLinkRequest
	if !readJSON(w, r, &in) {
		return
	}
	base := strings.TrimRight(strings.TrimSpace(in.URL), "/")
	if base == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}
	// the token comes back over this address: the same rule as a typed-in URL
	if err := checkSecretURL(base); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.startJellyfinLink(w, r, jellyfinServerFlow, base)
}

// handleJellyfinServerLinkPoll stores the server once the code was entered by
// an administrator: listing the libraries needs one.
//
//	@Summary		Poll Jellyfin server sign-in
//	@Tags			Settings
//	@Produce		json
//	@Param			id	query		string	true	"id from link/start"
//	@Success		200	{object}	jellyfinPollResponse
//	@Failure		403	{object}	ErrorResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/jellyfin/server/link/poll [get]
func (s *Server) handleJellyfinServerLinkPoll(w http.ResponseWriter, r *http.Request) {
	sg, token, user, ok := s.pollJellyfinLink(w, r, jellyfinServerFlow)
	if !ok {
		return
	}
	if token == "" {
		writeJSON(w, http.StatusOK, jellyfinPollResponse{})
		return
	}
	if !user.Policy.IsAdministrator {
		writeErr(w, http.StatusForbidden, "that Jellyfin account is no administrator")
		return
	}
	enc, err := secret.EncodeSetting(token)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt error")
		return
	}
	if err := saveSettings(s.DB, "jellyfin_url", sg.url, "jellyfin_token", enc, "jellyfin_auth", "signin"); err != nil {
		slog.Error("jellyfin server settings", "err", err)
		dbErr(w, err)
		return
	}
	slog.Info("jellyfin server connected", "url", logSafe(sg.url), "user", logSafe(user.Name))
	s.Transfers.SetRoots(s.localRoots())
	s.spawn(s.refreshPlexRoots)
	writeJSON(w, http.StatusOK, jellyfinPollResponse{Linked: true, User: user.Name})
}

// handleJellyfinLinkStart begins linking the user's own Jellyfin account.
//
//	@Summary		Start Jellyfin account link
//	@Description	Ask the configured Jellyfin server for a Quick Connect code, to read the user's favourites as their watchlist.
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	jellyfinLinkResponse
//	@Failure		409	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/jellyfin/link/start [post]
func (s *Server) handleJellyfinLinkStart(w http.ResponseWriter, r *http.Request) {
	base := db.SettingOrEnv(s.DB, "jellyfin_url", "JELLYFIN_URL")
	if c := s.plexClient(); c == nil || c.Kind() != "jellyfin" || base == "" {
		writeErr(w, http.StatusConflict, "no Jellyfin server connected")
		return
	}
	s.startJellyfinLink(w, r, jellyfinAccountFlow, strings.TrimRight(base, "/"))
}

// handleJellyfinLinkPoll stores the user's Jellyfin token once the code was
// entered, in the same per-user slot a plex.tv account uses.
//
//	@Summary		Poll Jellyfin account link
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id	query		string	true	"id from link/start"
//	@Success		200	{object}	jellyfinPollResponse
//	@Failure		404	{object}	ErrorResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/jellyfin/link/poll [get]
func (s *Server) handleJellyfinLinkPoll(w http.ResponseWriter, r *http.Request) {
	_, token, user, ok := s.pollJellyfinLink(w, r, jellyfinAccountFlow)
	if !ok {
		return
	}
	if token == "" {
		writeJSON(w, http.StatusOK, jellyfinPollResponse{})
		return
	}
	enc, err := secret.Encrypt(token)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt failed")
		return
	}
	u := auth.UserFrom(r.Context())
	if _, err := s.DB.Exec(`INSERT OR REPLACE INTO plex_accounts (user_id, token_enc, plex_user, created_at) VALUES (?, ?, ?, ?)`,
		u.ID, enc, user.Name, time.Now().UTC().Format(time.RFC3339)); err != nil {
		dbErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, jellyfinPollResponse{Linked: true, User: user.Name})
}

// jellyfinFavorites reads a linked user's favourites from the configured
// Jellyfin server, as plex.tv watchlist entries; nil when Jellyfin is not the
// server or the user has no account linked.
func (s *Server) jellyfinFavorites(userID int64) ([]PlexWatchItem, error) {
	c := s.plexClient()
	if c == nil || c.Kind() != "jellyfin" {
		return nil, nil
	}
	token := s.plexAccountToken(userID)
	if token == "" {
		return nil, nil
	}
	uc := jellyfin.New(db.SettingOrEnv(s.DB, "jellyfin_url", "JELLYFIN_URL"), token)
	uc.DeviceID = s.jellyfinDevice(jellyfinAccountFlow, userID)
	favs, err := uc.Favorites()
	if err != nil {
		return nil, err
	}
	out := make([]PlexWatchItem, 0, len(favs))
	for _, f := range favs {
		out = append(out, PlexWatchItem{Title: f.Title, Year: f.Year, Type: f.Type, TVDB: f.TVDB, TMDB: f.TMDB})
	}
	return out, nil
}
