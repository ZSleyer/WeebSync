package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/secret"
)

// plexProduct is the app name shown on the plex.tv authorised-devices page.
const plexProduct = "WeebSync"

// plexClientID returns the instance's stable plex.tv client identifier,
// generating and storing one on first use. plex.tv ties a PIN to this id, so it
// must be the same for creating and polling a PIN.
func (s *Server) plexClientID() string {
	if id := db.Setting(s.DB, "plex_client_id"); id != "" {
		return id
	}
	b := make([]byte, 16)
	rand.Read(b)
	id := hex.EncodeToString(b)
	db.SetSetting(s.DB, "plex_client_id", id)
	return id
}

// plexTVGet does an authenticated plex.tv API GET with the standard headers.
func (s *Server) plexTVReq(method, rawURL, token string) (*http.Response, error) {
	req, err := http.NewRequest(method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Plex-Product", plexProduct)
	req.Header.Set("X-Plex-Client-Identifier", s.plexClientID())
	if token != "" {
		req.Header.Set("X-Plex-Token", token)
	}
	return netguard.Client(15 * time.Second).Do(req)
}

// plexLinkResponse is returned when starting the PIN link flow.
type plexLinkResponse struct {
	ID   int    `json:"id"`
	Code string `json:"code"`
	URL  string `json:"url"` // the plex.tv page the user opens to authorise
}

// handlePlexLinkStart begins the plex.tv PIN flow: it creates a PIN and returns
// the code plus the URL the user visits to authorise this instance.
//
//	@Summary		Start plex.tv account link
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	plexLinkResponse
//	@Failure		502	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/plex/link/start [post]
func (s *Server) handlePlexLinkStart(w http.ResponseWriter, r *http.Request) {
	resp, err := s.plexTVReq(http.MethodPost, "https://plex.tv/api/v2/pins?strong=true", "")
	if err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv unreachable")
		return
	}
	defer resp.Body.Close()
	var pin struct {
		ID   int    `json:"id"`
		Code string `json:"code"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pin); err != nil || pin.ID == 0 {
		writeErr(w, http.StatusBadGateway, "plex.tv PIN failed")
		return
	}
	// the hash fragment carries the params the plex.tv auth page reads
	authURL := fmt.Sprintf("https://app.plex.tv/auth#?clientID=%s&code=%s&context%%5Bdevice%%5D%%5Bproduct%%5D=%s",
		url.QueryEscape(s.plexClientID()), url.QueryEscape(pin.Code), url.QueryEscape(plexProduct))
	writeJSON(w, http.StatusOK, plexLinkResponse{ID: pin.ID, Code: pin.Code, URL: authURL})
}

// handlePlexLinkPoll checks whether the user has authorised the PIN yet. When
// they have, it stores the account token and reports the linked user.
//
//	@Summary		Poll plex.tv account link
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id	query	int	true	"PIN id from link/start"
//	@Success		200	{object}	plexAccountResponse
//	@Security		CookieAuth
//	@Router			/api/plex/link/poll [get]
func (s *Server) handlePlexLinkPoll(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := r.URL.Query().Get("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	resp, err := s.plexTVReq(http.MethodGet, "https://plex.tv/api/v2/pins/"+url.PathEscape(id), "")
	if err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv unreachable")
		return
	}
	defer resp.Body.Close()
	var pin struct {
		AuthToken string `json:"authToken"`
	}
	json.NewDecoder(resp.Body).Decode(&pin)
	if pin.AuthToken == "" {
		writeJSON(w, http.StatusOK, plexAccountResponse{Linked: false}) // still waiting
		return
	}
	name := s.plexTVUser(pin.AuthToken)
	enc, err := secret.Encrypt(pin.AuthToken)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt failed")
		return
	}
	s.DB.Exec(`INSERT OR REPLACE INTO plex_accounts (user_id, token_enc, plex_user, created_at) VALUES (?, ?, ?, ?)`,
		u.ID, enc, name, time.Now().UTC().Format(time.RFC3339))
	writeJSON(w, http.StatusOK, plexAccountResponse{Linked: true, User: name})
}

// plexTVUser reads the account's display name (best-effort, for the status line).
func (s *Server) plexTVUser(token string) string {
	resp, err := s.plexTVReq(http.MethodGet, "https://plex.tv/api/v2/user", token)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var acc struct {
		Username string `json:"username"`
		Title    string `json:"title"`
	}
	json.NewDecoder(resp.Body).Decode(&acc)
	if acc.Username != "" {
		return acc.Username
	}
	return acc.Title
}

// plexAccountResponse is the account status shown on the settings page.
type plexAccountResponse struct {
	Linked bool   `json:"linked"`
	User   string `json:"user,omitempty"`
}

// handlePlexAccount reports whether the user has a linked plex.tv account.
//
//	@Summary		plex.tv account status
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	plexAccountResponse
//	@Security		CookieAuth
//	@Router			/api/plex/account [get]
func (s *Server) handlePlexAccount(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var name string
	err := s.DB.QueryRow(`SELECT plex_user FROM plex_accounts WHERE user_id = ?`, u.ID).Scan(&name)
	writeJSON(w, http.StatusOK, plexAccountResponse{Linked: err == nil, User: name})
}

// handlePlexAccountDisconnect drops the stored plex.tv token.
//
//	@Summary		Unlink plex.tv account
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{object}	OkResponse
//	@Security		CookieAuth
//	@Router			/api/plex/account [delete]
func (s *Server) handlePlexAccountDisconnect(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	s.DB.Exec(`DELETE FROM plex_accounts WHERE user_id = ?`, u.ID)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// plexAccountToken decrypts the user's stored plex.tv token, "" when unlinked.
func (s *Server) plexAccountToken(userID int64) string {
	var enc []byte
	if s.DB.QueryRow(`SELECT token_enc FROM plex_accounts WHERE user_id = ?`, userID).Scan(&enc) != nil {
		return ""
	}
	t, err := secret.Decrypt(enc)
	if err != nil {
		return ""
	}
	return t
}

// PlexWatchItem is one entry of the user's plex.tv watchlist.
type PlexWatchItem struct {
	Title string `json:"title"`
	Year  int    `json:"year"`
	Type  string `json:"type"` // show | movie
	TVDB  int    `json:"tvdb"`
	TMDB  int    `json:"tmdb"`
}

// handlePlexWatchlist returns the linked account's plex.tv watchlist, minus
// items the user has ignored.
//
//	@Summary		plex.tv watchlist
//	@Tags			Suggestions
//	@Produce		json
//	@Success		200	{array}	PlexWatchItem
//	@Security		CookieAuth
//	@Router			/api/plex/watchlist [get]
func (s *Server) handlePlexWatchlist(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	token := s.plexAccountToken(u.ID)
	if token == "" {
		writeJSON(w, http.StatusOK, []PlexWatchItem{})
		return
	}
	resp, err := s.plexTVReq(http.MethodGet,
		"https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1", token)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv unreachable")
		return
	}
	defer resp.Body.Close()
	var body struct {
		MediaContainer struct {
			Metadata []struct {
				Title string `json:"title"`
				Year  int    `json:"year"`
				Type  string `json:"type"`
				Guid  []struct {
					ID string `json:"id"`
				} `json:"Guid"`
			} `json:"Metadata"`
		} `json:"MediaContainer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadGateway, "plex.tv watchlist failed")
		return
	}
	ignored := s.dismissedKeys(u.ID, "suggestion")
	out := []PlexWatchItem{}
	for _, m := range body.MediaContainer.Metadata {
		it := PlexWatchItem{Title: m.Title, Year: m.Year, Type: m.Type}
		for _, g := range m.Guid {
			if strings.HasPrefix(g.ID, "tvdb://") {
				it.TVDB = idFromGuidStr(g.ID)
			}
			if strings.HasPrefix(g.ID, "tmdb://") {
				it.TMDB = idFromGuidStr(g.ID)
			}
		}
		key := fmt.Sprintf("plexwatch:%s:%d", strings.ToLower(m.Title), m.Year)
		if ignored[key] {
			continue
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, out)
}

// idFromGuidStr pulls the numeric id out of a "provider://12345" guid.
func idFromGuidStr(guid string) int {
	i := strings.Index(guid, "://")
	if i < 0 {
		return 0
	}
	n := 0
	for _, r := range guid[i+3:] {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}
