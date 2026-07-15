package api

import (
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"key": s.Push.PublicKey()})
}

type pushSubInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in pushSubInput
	if !readJSON(w, r, &in) {
		return
	}
	if in.Endpoint == "" || in.Keys.P256dh == "" || in.Keys.Auth == "" {
		writeErr(w, http.StatusBadRequest, "endpoint and keys required")
		return
	}
	if err := s.Push.Subscribe(u.ID, in.Endpoint, in.Keys.P256dh, in.Keys.Auth); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in pushSubInput
	if !readJSON(w, r, &in) {
		return
	}
	s.Push.Unsubscribe(u.ID, in.Endpoint)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
