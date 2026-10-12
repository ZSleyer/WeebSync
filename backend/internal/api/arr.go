package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

// WeebSync as a source for Sonarr and Radarr, entirely opt-in. Two standard
// interfaces the apps already speak, so nothing has to be added upstream:
//
//   - a Newznab indexer (arr_feed.go) listing the remote files under release
//     names the apps can read - added in Prowlarr as "Generic Newznab" or in
//     Sonarr/Radarr directly;
//   - a SABnzbd-compatible download client (arr_sab.go) that fetches a grabbed
//     release from its server into a folder the app imports from.
//
// The apps decide what to grab: quality profile, cutoff, upgrades, custom
// formats. Without the arr key every route answers 404 and nothing runs in
// the background, so an install that does not use it behaves as before.

// arrGate serves next only for a request carrying the arr key (?apikey=, the
// way both Newznab and SABnzbd clients send it). No session, no cookie: the
// key is the whole authentication, which is also why this is CSRF-immune.
func (s *Server) arrGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stored := db.Setting(s.DB, "arr_key_hash")
		if stored == "" {
			http.NotFound(w, r)
			return
		}
		// ponytail: no rate limit on bad keys - a 128-bit random key cannot be
		// guessed; add the auth limiter if the key ever becomes user-chosen.
		// The key is read from the query string only: FormValue would parse a
		// multipart body before anyone is authenticated.
		sum := sha256.Sum256([]byte(r.URL.Query().Get("apikey")))
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(stored)) != 1 {
			writeErr(w, http.StatusUnauthorized, "invalid api key")
			return
		}
		// an nzb stub is a few hundred bytes; nothing an app sends comes near
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		next(w, r)
	}
}

// handleArrKeyCreate mints the key Sonarr/Radarr/Prowlarr use for both the
// indexer and the download client. The gate checks its sha256; the key itself
// is kept encrypted so the settings page can show it again - it goes into
// three apps, and a key that is gone after a reload got regenerated, which
// cut all of them off. Minting a new one revokes the old.
//
// @Summary      Create Sonarr/Radarr key
// @Description  Mints the API key Sonarr, Radarr and Prowlarr use for the WeebSync indexer and download client, admin only. Switches the source on and revokes any previous key.
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  tokenResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/arr-key [post]
func (s *Server) handleArrKeyCreate(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		writeErr(w, http.StatusInternalServerError, "rng error")
		return
	}
	// 32 hex characters: the length Sonarr/Radarr expect of an API key
	key := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(key))
	if err := secret.SetSetting(s.DB, "arr_key", key); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not store the key")
		return
	}
	if err := db.SetSetting(s.DB, "arr_key_hash", hex.EncodeToString(sum[:])); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{Token: key})
}

// handleArrKeyGet shows the current key again.
//
// @Summary      Show Sonarr/Radarr key
// @Description  Returns the current Sonarr/Radarr API key, admin only. 404 while the source is off, or for a key minted before keys were kept (only its hash exists; mint a new one to see it).
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  tokenResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/arr-key [get]
func (s *Server) handleArrKeyGet(w http.ResponseWriter, r *http.Request) {
	key := secret.SettingOrEnv(s.DB, "arr_key", "")
	if key == "" || db.Setting(s.DB, "arr_key_hash") == "" {
		writeErr(w, http.StatusNotFound, "no key to show")
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{Token: key})
}

// handleArrKeyDelete switches the source off.
//
// @Summary      Delete Sonarr/Radarr key
// @Description  Revokes the Sonarr/Radarr key, which switches the indexer and download client off (their routes answer 404). Admin only.
// @Tags         Settings
// @Produce      json
// @Success      200  {object}  OkResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/settings/arr-key [delete]
func (s *Server) handleArrKeyDelete(w http.ResponseWriter, r *http.Request) {
	if err := db.SetSetting(s.DB, "arr_key_hash", ""); err != nil {
		dbErr(w)
		return
	}
	db.SetSetting(s.DB, "arr_key", "")
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// isArrJob reports whether a download carries a grab from Sonarr/Radarr.
func (s *Server) isArrJob(downloadID int64) bool {
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM arr_jobs WHERE download_id = ?`, downloadID).Scan(&n)
	return n > 0
}

// arrRootConfig parses arr_roots like plex_roots: "appPath => localPath" lines
// for apps that see the media under another path than this host, or a bare
// local root. The local side widens the write allowlist.
func (s *Server) arrRootConfig() (roots []string, maps [][2]string) {
	if s.DB == nil {
		return
	}
	return parsePlexRoots(db.Setting(s.DB, "arr_roots"))
}

// arrAppPath is the other direction of the mapping: a local path as the app
// sees it, which is what the download client reports as a job's storage.
// Unchanged when no mapping covers it (both see the same mount).
func (s *Server) arrAppPath(local string) string {
	_, maps := s.arrRootConfig()
	rev := make([][2]string, len(maps))
	for i, m := range maps {
		rev[i] = [2]string{m[1], m[0]}
	}
	return applyPathMap(local, rev)
}

// arrCompleteDir is the local folder finished grabs land in, resolved against
// the allowlist; "" when unset or outside every root.
func (s *Server) arrCompleteDir() string {
	dir := strings.TrimSpace(db.Setting(s.DB, "arr_complete_dir"))
	if dir == "" {
		return ""
	}
	abs, err := s.safeLocal(dir)
	if err != nil {
		return ""
	}
	return abs
}
