package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/secret"
)

type serverInfo struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	RootPath string `json:"rootPath"`
}

type serverInput struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"` // empty on update = keep existing
	RootPath string `json:"rootPath"`
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
	return in.Name != "" && in.Host != "" && in.Username != "" && in.Port > 0 && in.Port < 65536
}

func (s *Server) handleServersList(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	rows, err := s.DB.Query(`SELECT id, name, protocol, host, port, username, root_path
		FROM servers WHERE user_id = ? ORDER BY name`, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	list := []serverInfo{}
	for rows.Next() {
		var si serverInfo
		if err := rows.Scan(&si.ID, &si.Name, &si.Protocol, &si.Host, &si.Port, &si.Username, &si.RootPath); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		list = append(list, si)
	}
	writeJSON(w, http.StatusOK, list)
}

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
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, in.Name, in.Protocol, in.Host, in.Port, in.Username, enc, in.RootPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, serverInfo{ID: id, Name: in.Name, Protocol: in.Protocol,
		Host: in.Host, Port: in.Port, Username: in.Username, RootPath: in.RootPath})
}

func (s *Server) handleServerUpdate(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in serverInput
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() {
		writeErr(w, http.StatusBadRequest, "invalid server config")
		return
	}
	if in.Password != "" {
		enc, err := secret.Encrypt(in.Password)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		// credentials changed: reset the learned host key too
		_, err = s.DB.Exec(`UPDATE servers SET name=?, protocol=?, host=?, port=?, username=?, secret_enc=?, root_path=?, host_key=''
			WHERE id=? AND user_id=?`, in.Name, in.Protocol, in.Host, in.Port, in.Username, enc, in.RootPath, id, u.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	} else {
		if _, err := s.DB.Exec(`UPDATE servers SET name=?, protocol=?, host=?, port=?, username=?, root_path=?
			WHERE id=? AND user_id=?`, in.Name, in.Protocol, in.Host, in.Port, in.Username, in.RootPath, id, u.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleServerDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if _, err := s.DB.Exec(`DELETE FROM servers WHERE id = ? AND user_id = ?`, id, u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleServerTest dials the server and lists its root to validate the config.
func (s *Server) handleServerTest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	client, rootPath, err := s.DialServer(u.ID, id)
	if err != nil {
		if errors.Is(err, remote.ErrHostKeyMismatch) {
			// 409 + code so the UI can offer "trust the new host key"
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": err.Error(),
				"code":  "host_key_mismatch",
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleServerTrustHostKey drops the learned SSH host key after the user
// explicitly accepted that the server key changed; the next connect
// re-learns the new key via trust-on-first-use.
func (s *Server) handleServerTrustHostKey(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	res, err := s.DB.Exec(`UPDATE servers SET host_key='' WHERE id = ? AND user_id = ?`, id, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "server not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DialServer loads a user's server config and opens a connection.
func (s *Server) DialServer(userID, serverID int64) (remote.Client, string, error) {
	var cfg remote.Config
	var enc []byte
	var rootPath string
	err := s.DB.QueryRow(`SELECT protocol, host, port, username, secret_enc, root_path, host_key
		FROM servers WHERE id = ? AND user_id = ?`, serverID, userID).
		Scan(&cfg.Protocol, &cfg.Host, &cfg.Port, &cfg.Username, &enc, &rootPath, &cfg.HostKey)
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
	client, err := remote.Dial(cfg)
	if err != nil {
		return nil, "", err
	}
	return client, rootPath, nil
}
