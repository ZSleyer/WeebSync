package api

import (
	"net/http"
	"net/url"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/push"
)

// PushKeyResponse carries the server's VAPID public key for web push.
type PushKeyResponse struct {
	Key string `json:"key"`
}

// @Summary      Web push public key
// @Description  Returns the VAPID public key browsers use to subscribe to push notifications.
// @Tags         Push
// @Produce      json
// @Success      200  {object}  PushKeyResponse
// @Security     CookieAuth
// @Router       /api/push/key [get]
func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, PushKeyResponse{Key: s.Push.PublicKey()})
}

type pushSubInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// @Summary      Subscribe to web push
// @Description  Registers a browser push subscription (endpoint + keys) for the authenticated user. The endpoint is validated against SSRF-prone targets before being stored.
// @Tags         Push
// @Accept       json
// @Produce      json
// @Param        subscription  body      pushSubInput  true  "Push subscription"
// @Success      201  {object}  OkResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/push/subscribe [post]
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
	// the push endpoint is fetched server-side on every notification; block
	// metadata/link-local targets so it can't become an SSRF primitive
	if u, err := url.Parse(in.Endpoint); err != nil || u.Hostname() == "" {
		writeErr(w, http.StatusBadRequest, "invalid endpoint")
		return
	} else if err := netguard.Allowed(u.Hostname()); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Push.Subscribe(u.ID, in.Endpoint, in.Keys.P256dh, in.Keys.Auth); err != nil {
		dbErr(w)
		return
	}
	writeJSON(w, http.StatusCreated, OkResponse{Status: "ok"})
}

// @Summary      Unsubscribe from web push
// @Description  Removes a browser push subscription for the authenticated user.
// @Tags         Push
// @Accept       json
// @Produce      json
// @Param        subscription  body      pushSubInput  true  "Push subscription"
// @Success      200  {object}  OkResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/push/subscribe [delete]
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in pushSubInput
	if !readJSON(w, r, &in) {
		return
	}
	s.Push.Unsubscribe(u.ID, in.Endpoint)
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}

// @Summary      Send a test push
// @Description  Sends a test notification to all of the caller's push subscriptions, so a subscription can be verified without waiting for a real download.
// @Tags         Push
// @Produce      json
// @Success      200  {object}  OkResponse
// @Security     CookieAuth
// @Router       /api/push/test [post]
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	locale := s.userLocale(u.ID)
	s.Push.Notify(u.ID, push.Notification{
		Title: tr(locale, "push.testTitle"),
		Body:  tr(locale, "push.testBody"),
		Tag:   "test",
		URL:   "/settings/notifications",
	})
	writeJSON(w, http.StatusOK, OkResponse{Status: "ok"})
}
