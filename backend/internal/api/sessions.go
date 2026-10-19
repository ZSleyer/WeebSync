package api

import (
	"net/http"
	"regexp"

	"github.com/ch4d1/weebsync/internal/auth"
)

// sessionInfo is one signed-in browser of the account. ID is a prefix of the
// stored token hash: enough to name the session, useless as a credential.
type sessionInfo struct {
	ID          string `json:"id"`
	CreatedAt   string `json:"createdAt"` // "" for sessions older than the column
	ExpiresAt   string `json:"expiresAt"`
	LastSeen    string `json:"lastSeen"`    // stamped at most every few minutes
	IP          string `json:"ip"`          // where it was last used from, "" until then
	City        string `json:"city"`        // approximate, from the DB-IP database; "" when unknown or off
	CountryCode string `json:"countryCode"` // ISO 3166-1 alpha-2, "" when unknown or off
	UserAgent   string `json:"userAgent"`
	OIDC        bool   `json:"oidc"`
	Current     bool   `json:"current"`
}

const sessionIDLen = 16

var sessionIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// handleSessionsList lists the account's sessions, the current one marked.
//
//	@Summary		List sessions
//	@Description	The signed-in browsers of the account, newest first. City and countryCode are an approximation from a local database, empty for local addresses or while the lookup is off.
//	@Tags			Auth
//	@Produce		json
//	@Success		200	{array}		sessionInfo
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/sessions [get]
func (s *Server) handleSessionsList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	cur := auth.TokenHash(auth.SessionToken(r))
	rows, err := s.DB.Query(`SELECT token_hash, created_at, expires_at, last_seen, ip, user_agent, oidc_sid != '' OR oidc_sub != ''
		FROM sessions WHERE user_id = ? ORDER BY created_at DESC`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	geo := s.geoipReader()
	out := []sessionInfo{}
	for rows.Next() {
		var hash string
		var it sessionInfo
		if err := rows.Scan(&hash, &it.CreatedAt, &it.ExpiresAt, &it.LastSeen, &it.IP, &it.UserAgent, &it.OIDC); err != nil {
			dbErr(w)
			return
		}
		it.ID, it.Current = hash[:sessionIDLen], hash == cur
		p := geoipPlace(geo, it.IP)
		it.City, it.CountryCode = p.City, p.Country
		out = append(out, it)
	}
	if rows.Err() != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleSessionDelete ends one session of the account. The current one ends
// through logout, which also clears the cookie.
//
//	@Summary		End a session
//	@Description	Signs one browser of the account out. Not the current one: that is logout.
//	@Tags			Auth
//	@Produce		json
//	@Param			id	path		string	true	"Session id from the list"
//	@Success		200	{object}	OkResponse
//	@Failure		400	{object}	ErrorResponse
//	@Failure		404	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/sessions/{id} [delete]
func (s *Server) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		writeErr(w, http.StatusBadRequest, "invalid session id")
		return
	}
	cur := auth.TokenHash(auth.SessionToken(r))
	res, err := s.DB.Exec(`DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, ?) = ? AND token_hash != ?`,
		u.ID, sessionIDLen, id, cur)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// sessionsEndedResponse says how many sessions were ended.
type sessionsEndedResponse struct {
	Ended int64 `json:"ended"`
}

// handleSessionsEndOthers signs every other browser of the account out.
//
//	@Summary		End all other sessions
//	@Description	Signs every browser of the account out except this one.
//	@Tags			Auth
//	@Produce		json
//	@Success		200	{object}	sessionsEndedResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/auth/sessions/others [delete]
func (s *Server) handleSessionsEndOthers(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	res, err := s.DB.Exec(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`,
		u.ID, auth.TokenHash(auth.SessionToken(r)))
	if err != nil {
		dbErr(w)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, sessionsEndedResponse{Ended: n})
}
