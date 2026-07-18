package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/secret"
)

// TMDB account linking (v3 request-token flow) plus the TMDB suggestions
// endpoint (watchlist ∩ remote index, and trending ∩ remote index).

// tmdbAccount returns the linked TMDB account of a weebsync user.
func (s *Server) tmdbAccount(userID int64) (accountID int, session string, err error) {
	var enc []byte
	if err := s.DB.QueryRow(`SELECT tmdb_account_id, session_enc FROM tmdb_accounts WHERE user_id = ?`, userID).
		Scan(&accountID, &enc); err != nil {
		return 0, "", fmt.Errorf("no linked TMDB account")
	}
	session, err = secret.Decrypt(enc)
	if err != nil {
		return 0, "", err
	}
	return accountID, session, nil
}

// handleTmdbConnect starts the linking flow: request token → TMDB approval
// page → callback below.
func (s *Server) handleTmdbConnect(w http.ResponseWriter, r *http.Request) {
	if !s.Tmdb.Enabled() {
		writeErr(w, http.StatusBadRequest, "TMDB not configured")
		return
	}
	token, err := s.Tmdb.RequestToken(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// the approval page redirects back with the token in the query; the
	// cookie binds the callback to this browser (CSRF)
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_tmdb_rt", Value: token, Path: "/api/tmdb",
		MaxAge: 600, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: auth.IsHTTPS(r),
	})
	redirect := requestOrigin(r) + "/api/tmdb/callback"
	http.Redirect(w, r, "https://www.themoviedb.org/authenticate/"+token+"?redirect_to="+url.QueryEscape(redirect), http.StatusFound)
}

// handleTmdbCallback finishes the flow: token check, session creation,
// account lookup, encrypted session storage.
func (s *Server) handleTmdbCallback(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rtCookie, err := r.Cookie("weebsync_tmdb_rt")
	if err != nil || r.URL.Query().Get("request_token") != rtCookie.Value {
		http.Error(w, "invalid request token", http.StatusBadRequest)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_tmdb_rt", Value: "", Path: "/api/tmdb",
		MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	if r.URL.Query().Get("denied") == "true" || r.URL.Query().Get("approved") == "false" {
		http.Redirect(w, r, "/settings", http.StatusFound)
		return
	}
	session, err := s.Tmdb.CreateSession(r.Context(), rtCookie.Value)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	accountID, username, err := s.Tmdb.Account(r.Context(), session)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	enc, err := secret.Encrypt(session)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := s.DB.Exec(`INSERT OR REPLACE INTO tmdb_accounts (user_id, tmdb_account_id, tmdb_username, session_enc)
		VALUES (?, ?, ?, ?)`, u.ID, accountID, username, enc); err != nil {
		http.Error(w, "failed to store linked account", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/settings", http.StatusFound)
}

func (s *Server) handleTmdbDisconnect(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	s.DB.Exec(`DELETE FROM tmdb_accounts WHERE user_id = ?`, u.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleTmdbMe reports the linked account for the settings UI.
func (s *Server) handleTmdbMe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	out := map[string]any{"configured": s.Tmdb.Enabled(), "connected": false}
	var name string
	if err := s.DB.QueryRow(`SELECT tmdb_username FROM tmdb_accounts WHERE user_id = ?`, u.ID).Scan(&name); err == nil {
		out["connected"] = true
		out["username"] = name
	}
	writeJSON(w, http.StatusOK, out)
}

type tmdbSuggestion struct {
	Media      anilist.Media   `json:"media"`
	Source     string          `json:"source"` // tmdb:tv | tmdb:movie
	PlexFolder string          `json:"plexFolder,omitempty"`
	Candidates []plexCandidate `json:"candidates"`
}

// tmdbSuggestList maps medias to suggestions, attaching any server candidates.
// When discovery is false (watchlist) it keeps only titles present on a server;
// when true (trending) it keeps all, so trending is pure API discovery.
func (s *Server) tmdbSuggestList(userID int64, kind string, medias []anilist.Media, discovery bool) []tmdbSuggestion {
	out := []tmdbSuggestion{}
	for _, m := range medias {
		cands := s.remoteCandidates(userID, m)
		if len(cands) == 0 && !discovery {
			continue
		}
		out = append(out, tmdbSuggestion{Media: m, Source: "tmdb:" + kind, Candidates: cands})
	}
	medlist := make([]anilist.Media, 0, len(out))
	for _, sug := range out {
		medlist = append(medlist, sug.Media)
	}
	folders := s.plexFolderNames(medlist)
	for i := range out {
		out[i].PlexFolder = folders[out[i].Media.ID]
	}
	return out
}

// handleTmdbSuggestions lists TMDB watchlist and trending titles that exist
// on the user's servers. Watchlist needs a linked account; trending only the
// API key. ?force=1 bypasses the watchlist cache.
func (s *Server) handleTmdbSuggestions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	out := map[string]any{
		"configured": s.Tmdb.Enabled(),
		"connected":  false,
		"watchlist":  []tmdbSuggestion{},
		"trending":   []tmdbSuggestion{},
	}
	if !s.Tmdb.Enabled() {
		writeJSON(w, http.StatusOK, out)
		return
	}
	force := r.URL.Query().Get("force") == "1"
	watchlist := []tmdbSuggestion{}
	trending := []tmdbSuggestion{}
	for _, kind := range []string{"tv", "movie"} {
		if list, err := s.Tmdb.Trending(r.Context(), kind); err == nil {
			trending = append(trending, s.tmdbSuggestList(u.ID, kind, list, true)...)
		}
	}
	if accountID, session, err := s.tmdbAccount(u.ID); err == nil {
		out["connected"] = true
		for _, kind := range []string{"tv", "movie"} {
			key := fmt.Sprintf("tmdb:watchlist:%d:%s", accountID, kind)
			var medias []anilist.Media
			if payload, ok := s.cacheGet(key, time.Hour); ok && !force {
				json.Unmarshal([]byte(payload), &medias)
			} else if medias, err = s.Tmdb.Watchlist(r.Context(), session, accountID, kind); err == nil {
				payload, _ := json.Marshal(medias)
				s.cacheSet(key, string(payload))
			}
			watchlist = append(watchlist, s.tmdbSuggestList(u.ID, kind, medias, false)...)
		}
	}
	out["watchlist"] = watchlist
	out["trending"] = trending
	writeJSON(w, http.StatusOK, out)
}
