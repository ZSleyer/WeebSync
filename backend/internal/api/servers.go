package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/secret"
)

type serverInfo struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	Protocol       string `json:"protocol"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	RootPath       string `json:"rootPath"`
	MaxConnections int    `json:"maxConnections"`
}

type serverInput struct {
	Name           string `json:"name"`
	Protocol       string `json:"protocol"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Password       string `json:"password"` // empty on update = keep existing
	RootPath       string `json:"rootPath"`
	MaxConnections int    `json:"maxConnections"`
}

func (in *serverInput) valid() bool {
	switch in.Protocol {
	case "sftp", "ftps", "ftp":
	default:
		return false
	}
	if in.Port == 0 {
		if in.Protocol == "sftp" {
			in.Port = 22
		} else {
			in.Port = 21
		}
	}
	if in.RootPath == "" {
		in.RootPath = "/"
	}
	if in.MaxConnections < 1 {
		in.MaxConnections = 3
	}
	if in.MaxConnections > 10 {
		in.MaxConnections = 10
	}
	return in.Name != "" && in.Host != "" && in.Username != "" && in.Port > 0 && in.Port < 65536
}

// @Summary  List servers
// @Description Lists the authenticated user's configured remote servers.
// @Tags     Servers
// @Produce  json
// @Success  200 {array} serverInfo
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers [get]
func (s *Server) handleServersList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, name, protocol, host, port, username, root_path, max_connections
		FROM servers WHERE user_id = ? ORDER BY name`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	defer rows.Close()
	list := []serverInfo{}
	for rows.Next() {
		var si serverInfo
		if err := rows.Scan(&si.ID, &si.Name, &si.Protocol, &si.Host, &si.Port, &si.Username, &si.RootPath, &si.MaxConnections); err != nil {
			dbErr(w)
			return
		}
		list = append(list, si)
	}
	writeJSON(w, http.StatusOK, list)
}

// @Summary  Create server
// @Description Creates a new remote server for the authenticated user.
// @Tags     Servers
// @Accept   json
// @Produce  json
// @Param    body body serverInput true "Server configuration"
// @Success  201 {object} serverInfo
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers [post]
func (s *Server) handleServerCreate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in serverInput
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() || in.Password == "" {
		writeErr(w, http.StatusBadRequest, "name, protocol (sftp|ftps|ftp), host, username, password required")
		return
	}
	enc, err := secret.Encrypt(in.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path, max_connections)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.Name, in.Protocol, in.Host, in.Port, in.Username, enc, in.RootPath, in.MaxConnections)
	if err != nil {
		dbErr(w)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, serverInfo{ID: id, Name: in.Name, Protocol: in.Protocol,
		Host: in.Host, Port: in.Port, Username: in.Username, RootPath: in.RootPath, MaxConnections: in.MaxConnections})
}

// @Summary  Update server
// @Description Updates a remote server owned by the authenticated user. An empty password keeps the stored credentials.
// @Tags     Servers
// @Accept   json
// @Produce  json
// @Param    id   path int         true "Server ID"
// @Param    body body serverInput true "Server configuration"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id} [put]
func (s *Server) handleServerUpdate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var in serverInput
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() {
		writeErr(w, http.StatusBadRequest, "invalid server config")
		return
	}
	var res sql.Result
	if in.Password != "" {
		enc, err := secret.Encrypt(in.Password)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		// credentials changed: reset the learned host key too
		res, err = s.DB.Exec(`UPDATE servers SET name=?, protocol=?, host=?, port=?, username=?, secret_enc=?, root_path=?, max_connections=?, host_key=''
			WHERE id=? AND user_id=?`, in.Name, in.Protocol, in.Host, in.Port, in.Username, enc, in.RootPath, in.MaxConnections, id, u.ID)
		if err != nil {
			dbErr(w)
			return
		}
	} else {
		var err error
		res, err = s.DB.Exec(`UPDATE servers SET name=?, protocol=?, host=?, port=?, username=?, root_path=?, max_connections=?
			WHERE id=? AND user_id=?`, in.Name, in.Protocol, in.Host, in.Port, in.Username, in.RootPath, in.MaxConnections, id, u.ID)
		if err != nil {
			dbErr(w)
			return
		}
	}
	// no row updated = not this user's server: don't leak the id or evict its pool
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	// creds/host/limit may have changed: drop any pooled connections
	s.Conns.Evict(id)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// @Summary  Delete server
// @Description Deletes a remote server owned by the authenticated user.
// @Tags     Servers
// @Produce  json
// @Param    id path int true "Server ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id} [delete]
func (s *Server) handleServerDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	res, err := s.DB.Exec(`DELETE FROM servers WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	// catalog rows carry no foreign key any more (source id 0 is the local
	// filesystem, which has no server row), so clean them up here
	s.DB.Exec(`DELETE FROM catalog_matches WHERE server_id = ?`, id)
	s.DB.Exec(`DELETE FROM catalog_scopes WHERE server_id = ?`, id)
	s.DB.Exec(`DELETE FROM catalog_variants WHERE server_id = ?`, id)
	// drop provider links whose last physical match just vanished, then the
	// series left with no provider at all (series has real rows, so it cascades)
	s.DB.Exec(`DELETE FROM series_provider WHERE NOT EXISTS (
		SELECT 1 FROM catalog_matches m
		WHERE m.source = series_provider.source AND m.media_id = series_provider.media_id)`)
	s.DB.Exec(`DELETE FROM series WHERE id NOT IN (SELECT series_id FROM series_provider)`)
	s.Conns.Evict(id)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// HostKeyConflict is returned (409) by handleServerTest when the server's SSH
// host key is unknown or changed, so the UI can show both fingerprints and let
// the user explicitly accept or reject the offered key.
type HostKeyConflict struct {
	Error string `json:"error"`
	// Code is host_key_unknown (first contact) or host_key_mismatch.
	Code string `json:"code" example:"host_key_mismatch"`
	// NewKey is the offered key (base64); echo it back to /trust-hostkey on
	// accept so exactly the reviewed key gets pinned.
	NewKey         string `json:"newKey"`
	NewFingerprint string `json:"newFingerprint" example:"ssh-ed25519 SHA256:..."`
	// OldFingerprint is empty on first contact.
	OldFingerprint string `json:"oldFingerprint,omitempty"`
}

// handleServerTest dials the server and lists its root to validate the config.
// It never pins a host key itself - an untrusted key comes back as 409 with
// fingerprints, and only /trust-hostkey (explicit user accept) pins it.
// @Summary  Test server connection
// @Description Dials the server and lists its root path to validate the stored configuration. Never pins a host key; an unknown or changed SSH host key is reported as 409 with old/new fingerprints for explicit accept via /trust-hostkey.
// @Tags     Servers
// @Produce  json
// @Param    id path int true "Server ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  409 {object} HostKeyConflict "SSH host key unknown or changed"
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id}/test [post]
func (s *Server) handleServerTest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	client, rootPath, err := s.DialServer(u.ID, id)
	if err != nil {
		var hk *remote.HostKeyError
		if errors.As(err, &hk) {
			// 409 + fingerprints so the UI can ask accept/reject
			c := HostKeyConflict{Error: err.Error(), Code: "host_key_mismatch", NewKey: hk.Offered}
			c.NewFingerprint, _ = remote.KeyLabel(hk.Offered)
			if hk.Stored == "" {
				c.Code = "host_key_unknown"
			} else {
				c.OldFingerprint, _ = remote.KeyLabel(hk.Stored)
			}
			writeJSON(w, http.StatusConflict, c)
			return
		}
		status := http.StatusBadGateway
		if err == errNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	defer client.Close()
	if _, err := client.List(rootPath); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// TrustHostKeyInput carries the host key the user reviewed and accepted.
type TrustHostKeyInput struct {
	// Key is the base64 host key from the failed test's newKey field.
	Key string `json:"key"`
}

// handleServerTrustHostKey pins the exact host key whose fingerprint the user
// reviewed and accepted. Pinning the reviewed key (instead of clearing for a
// TOFU re-learn) means a key that changes again between review and accept
// fails the next connect instead of being trusted silently.
// @Summary  Trust host key
// @Description Pins the SSH host key the user explicitly accepted after reviewing its fingerprint.
// @Tags     Servers
// @Accept   json
// @Produce  json
// @Param    id path int true "Server ID"
// @Param    body body TrustHostKeyInput true "Accepted host key"
// @Success  200 {object} OkResponse
// @Failure  400 {object} ErrorResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id}/trust-hostkey [post]
func (s *Server) handleServerTrustHostKey(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	var in TrustHostKeyInput
	if !readJSON(w, r, &in) {
		return
	}
	if _, err := remote.KeyLabel(in.Key); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.DB.Exec(`UPDATE servers SET host_key = ? WHERE id = ? AND user_id = ?`, in.Key, id, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	// connections dialed under the old key may still be pooled
	s.Conns.Evict(id)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// DialServer leases a high-priority connection (downloads, browser, catalog,
// watch checks) for a user's server. The Client's Close returns it to the pool.
// A bounded wait keeps a request from hanging forever when the per-server
// connection limit is saturated.
func (s *Server) DialServer(userID, serverID int64) (remote.Client, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return s.dialServer(ctx, userID, serverID, pool.PriHigh)
}

// dialServer loads the server config and leases a connection at the given
// priority. Low priority (the index crawler) waits while downloads need the
// capacity; the ctx cancels a wait when the caller is done.
func (s *Server) dialServer(ctx context.Context, userID, serverID int64, prio pool.Prio) (remote.Client, string, error) {
	var cfg remote.Config
	var enc []byte
	var rootPath string
	err := s.DB.QueryRow(`SELECT protocol, host, port, username, secret_enc, root_path, host_key, max_connections
		FROM servers WHERE id = ? AND user_id = ?`, serverID, userID).
		Scan(&cfg.Protocol, &cfg.Host, &cfg.Port, &cfg.Username, &enc, &rootPath, &cfg.HostKey, &cfg.MaxConns)
	if err == sql.ErrNoRows {
		return nil, "", errNotFound
	}
	if err != nil {
		return nil, "", err
	}
	cfg.Password, err = secret.Decrypt(enc)
	if err != nil {
		return nil, "", err
	}
	client, err := s.Conns.Lease(ctx, serverID, cfg, prio)
	if err != nil {
		return nil, "", err
	}
	return client, rootPath, nil
}
