package anilist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

func TestExchangeCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		w.Write([]byte(`{"access_token":"tok123","token_type":"Bearer","expires_in":31536000}`))
	}))
	defer srv.Close()
	old := oauthTokenURL
	oauthTokenURL = srv.URL
	t.Cleanup(func() { oauthTokenURL = old })

	d := dbtest.Open(t)
	c := New(d)
	tok, exp, err := c.ExchangeCode(context.Background(), "id", "secret", "http://cb", "code")
	if err != nil || tok != "tok123" || exp != 31536000 {
		t.Fatalf("got %q %d %v", tok, exp, err)
	}

	// error response
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad", http.StatusBadRequest)
	}))
	defer srv2.Close()
	oauthTokenURL = srv2.URL
	if _, _, err := c.ExchangeCode(context.Background(), "id", "secret", "http://cb", "bad"); err == nil {
		t.Error("expected error")
	}
}
