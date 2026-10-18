package api

import (
	"net/http"
	"testing"
)

func TestHintDismissRoute(t *testing.T) {
	s, _ := hintServer(t)
	mux := http.NewServeMux()
	s.Register(mux)
	c := cookieForUser(t, s.DB, 1)
	f := "/Area/Neo Yokio [EngDub]"
	lookup(t, s, f, false)
	if w := doReq(mux, "POST", "/api/servers/1/catalog/hint/dismiss", `{"folder":"`+f+`"}`, c); w.Code != http.StatusOK {
		t.Fatalf("dismiss: %d %s", w.Code, w.Body)
	}
	if s.hintFor(1, f) != nil {
		t.Error("hint still offered after dismissal")
	}
	if w := doReq(mux, "POST", "/api/servers/1/catalog/hint/dismiss", `{"folder":"/a/../x"}`, c); w.Code != http.StatusBadRequest {
		t.Errorf("bad folder: %d", w.Code)
	}
}
