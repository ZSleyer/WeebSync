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
	s.Conns.Evict(id)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// HostKeyConflict is returned (409) by handleServerTest when the server's SSH
// host key changed, so the UI can offer to trust the new key.
type HostKeyConflict struct {
	Error string `json:"error"`
	Code  string `json:"code" example:"host_key_mismatch"`
}

// handleServerTest dials the server and lists its root to validate the config.
// @Summary  Test server connection
// @Description Dials the server and lists its root path to validate the stored configuration.
// @Tags     Servers
// @Produce  json
// @Param    id path int true "Server ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  409 {object} HostKeyConflict "SSH host key mismatch"
// @Failure  502 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id}/test [post]
func (s *Server) handleServerTest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	client, rootPath, err := s.DialServer(u.ID, id)
	if err != nil {
		if errors.Is(err, remote.ErrHostKeyMismatch) {
			// 409 + code so the UI can offer "trust the new host key"
			writeJSON(w, http.StatusConflict, HostKeyConflict{
				Error: err.Error(),
				Code:  "host_key_mismatch",
			})
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

// handleServerTrustHostKey drops the learned SSH host key after the user
// explicitly accepted that the server key changed; the next connect
// re-learns the new key via trust-on-first-use.
// @Summary  Trust new host key
// @Description Drops the learned SSH host key so the next connect re-learns it via trust-on-first-use.
// @Tags     Servers
// @Produce  json
// @Param    id path int true "Server ID"
// @Success  200 {object} OkResponse
// @Failure  401 {object} ErrorResponse
// @Failure  404 {object} ErrorResponse
// @Failure  500 {object} ErrorResponse
// @Security CookieAuth
// @Router   /api/servers/{id}/trust-hostkey [post]
func (s *Server) handleServerTrustHostKey(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := pathID(r)
	res, err := s.DB.Exec(`UPDATE servers SET host_key='' WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
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
	cfg.OnHostKey = func(key string) {
		s.DB.Exec(`UPDATE servers SET host_key = ? WHERE id = ?`, key, serverID)
	}
	client, err := s.Conns.Lease(ctx, serverID, cfg, prio)
	if err != nil {
		return nil, "", err
	}
	return client, rootPath, nil
}
