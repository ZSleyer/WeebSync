package netguard

import (
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A token sent to one origin does not follow a redirect to another, and a
// request that began over HTTPS never continues over HTTP.
func TestRedirectKeepsSecrets(t *testing.T) {
	var gotToken, gotAuth string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken, gotAuth = r.Header.Get("X-Plex-Token"), r.Header.Get("Authorization")
	}))
	defer other.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/next", http.StatusFound)
	}))
	defer origin.Close()

	c := Client(5 * time.Second)
	req, _ := http.NewRequest("GET", origin.URL, nil)
	req.Header.Set("X-Plex-Token", "secret-token")
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotToken != "" || gotAuth != "" {
		t.Errorf("credentials followed the redirect to another origin: token=%q auth=%q", gotToken, gotAuth)
	}

	// https -> http
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer plain.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL, http.StatusFound)
	}))
	defer secure.Close()
	c = Client(5 * time.Second)
	pool := x509.NewCertPool()
	pool.AddCert(secure.Certificate())
	c.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
	if resp, err := c.Get(secure.URL); err == nil {
		resp.Body.Close()
		t.Error("a redirect from HTTPS to HTTP was followed")
	}
}
