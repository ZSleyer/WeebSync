package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// AniList account linking (OAuth authorization code flow). Replaces the old
// manual API-token setting: once any account is linked, background matching
// runs authenticated via AnilistToken below.

// AnilistToken is the client's TokenSource: operator env token first, then
// any linked account's token (background matching has no user context).
func (s *Server) AnilistToken() string {
	if t := os.Getenv("ANILIST_TOKEN"); t != "" {
		return t
	}
	var enc []byte
	if err := s.DB.QueryRow(`SELECT token_enc FROM anilist_accounts LIMIT 1`).Scan(&enc); err != nil {
		return ""
	}
	t, err := secret.Decrypt(enc)
	if err != nil {
		return ""
	}
	return t
}

func (s *Server) anilistClientConfig() (id, sec, redirect string) {
	return db.SettingOrEnv(s.DB, "anilist_client_id", "ANILIST_CLIENT_ID"),
		db.SettingOrEnv(s.DB, "anilist_client_secret", "ANILIST_CLIENT_SECRET"),
		db.Setting(s.DB, "anilist_redirect_url")
}

// userToken returns the linked account of a weebsync user (nil error only
// with a usable token).
func (s *Server) anilistAccount(userID int64) (anilistUserID int, token string, err error) {
	var enc []byte
	if err := s.DB.QueryRow(`SELECT anilist_user_id, token_enc FROM anilist_accounts WHERE user_id = ?`, userID).
		Scan(&anilistUserID, &enc); err != nil {
		return 0, "", fmt.Errorf("no linked AniList account")
	}
	token, err = secret.Decrypt(enc)
	if err != nil {
		return 0, "", err
	}
	return anilistUserID, token, nil
}

// handleAnilistConnect starts the OAuth flow.
func (s *Server) handleAnilistConnect(w http.ResponseWriter, r *http.Request) {
	clientID, clientSecret, redirect := s.anilistClientConfig()
	if clientID == "" || clientSecret == "" {
		writeErr(w, http.StatusBadRequest, "AniList client not configured")
		return
	}
	if redirect == "" {
		redirect = requestOrigin(r) + "/api/anilist/callback"
	}
	raw := make([]byte, 16)
	rand.Read(raw)
	state := hex.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_anilist_state", Value: state, Path: "/api/anilist",
		MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	q := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirect},
		"response_type": {"code"},
		"state":         {state},
	}
	http.Redirect(w, r, "https://anilist.co/api/v2/oauth/authorize?"+q.Encode(), http.StatusFound)
}

func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// handleAnilistCallback finishes the flow: state check, code exchange,
// viewer lookup, encrypted token storage.
func (s *Server) handleAnilistCallback(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	stateCookie, err := r.Cookie("weebsync_anilist_state")
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	clientID, clientSecret, redirect := s.anilistClientConfig()
	if redirect == "" {
		redirect = requestOrigin(r) + "/api/anilist/callback"
	}
	token, expiresIn, err := s.Anilist.ExchangeCode(r.Context(), clientID, clientSecret, redirect, code)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	alID, name, avatar, err := s.Anilist.Viewer(r.Context(), token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	enc, err := secret.Encrypt(token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	expires := ""
	if expiresIn > 0 {
		expires = time.Now().UTC().Add(time.Duration(expiresIn) * time.Second).Format(sqliteTime)
	}
	s.DB.Exec(`INSERT OR REPLACE INTO anilist_accounts (user_id, anilist_user_id, anilist_name, avatar, token_enc, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)`, u.ID, alID, name, avatar, enc, expires)
	http.Redirect(w, r, "/settings", http.StatusFound)
}

func (s *Server) handleAnilistDisconnect(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	s.DB.Exec(`DELETE FROM anilist_accounts WHERE user_id = ?`, u.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAnilistMe reports the linked account for the settings UI.
func (s *Server) handleAnilistMe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	clientID, clientSecret, _ := s.anilistClientConfig()
	out := map[string]any{"configured": clientID != "" && clientSecret != "", "connected": false}
	var name, avatar, expires string
	if err := s.DB.QueryRow(`SELECT anilist_name, avatar, expires_at FROM anilist_accounts WHERE user_id = ?`, u.ID).
		Scan(&name, &avatar, &expires); err == nil {
		out["connected"] = true
		out["name"] = name
		out["avatar"] = avatar
		out["expiresAt"] = expires
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAnilistProgress sets the watched-episode count on the user's list.
func (s *Server) handleAnilistProgress(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in struct {
		MediaID  int `json:"mediaId"`
		Progress int `json:"progress"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.MediaID <= 0 || in.Progress < 0 {
		writeErr(w, http.StatusBadRequest, "mediaId and progress required")
		return
	}
	alID, token, err := s.anilistAccount(u.ID)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Anilist.SaveProgress(r.Context(), token, in.MediaID, in.Progress); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.Anilist.InvalidateUserList(alID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// anilistProgress returns mediaID → watched episodes from the cached list.
func (s *Server) anilistProgress(userID int64) map[int]int {
	alID, _, err := s.anilistAccount(userID)
	if err != nil {
		return nil
	}
	out := map[int]int{}
	for _, e := range s.Anilist.CachedUserList(alID) {
		if e.Progress > 0 {
			out[e.Media.ID] = e.Progress
		}
	}
	return out
}

type anilistSuggestion struct {
	Status     string          `json:"status"` // CURRENT | PLANNING
	Progress   int             `json:"progress"`
	Media      anilist.Media   `json:"media"`
	Candidates []plexCandidate `json:"candidates"`
}

// handleAnilistSuggestions lists watchlist titles (watching/planning) that
// exist on the user's servers, via the remote index.
func (s *Server) handleAnilistSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	alID, token, err := s.anilistAccount(u.ID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false, "building": false, "suggestions": []anilistSuggestion{}})
		return
	}
	// serve the cached list instantly; refresh in the background when stale
	list := s.Anilist.CachedUserList(alID)
	building := false
	var fetched string
	s.DB.QueryRow(`SELECT fetched_at FROM anilist_cache WHERE key = ?`, fmt.Sprintf("alist:%d", alID)).Scan(&fetched)
	if t, perr := time.Parse(sqliteTime, fetched); perr != nil || time.Since(t) > time.Hour || r.URL.Query().Get("force") == "1" {
		building = len(list) == 0
		if r.URL.Query().Get("force") == "1" {
			s.Anilist.InvalidateUserList(alID)
		}
		s.runJob(fmt.Sprintf("alist:%d", alID), func(ctx context.Context) {
			s.Anilist.UserList(ctx, token, alID)
		})
	}
	suggestions := []anilistSuggestion{}
	for _, e := range list {
		if e.Status != "CURRENT" && e.Status != "PLANNING" {
			continue
		}
		cands := s.remoteCandidates(u.ID, e.Media)
		if len(cands) == 0 {
			continue
		}
		suggestions = append(suggestions, anilistSuggestion{Status: e.Status, Progress: e.Progress, Media: e.Media, Candidates: cands})
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "building": building, "suggestions": suggestions})
}
