package plex

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func resource(t *testing.T, raw string) Resource {
	t.Helper()
	var r Resource
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

// Local before remote, relay last, https before the plain local address.
func TestCandidatesOrder(t *testing.T) {
	r := resource(t, `{"connections": [
		{"uri": "https://relay.plex.direct:8443", "relay": true},
		{"uri": "https://1-2-3-4.abc.plex.direct:32400", "address": "1.2.3.4", "port": 32400},
		{"uri": "https://192-168-1-5.abc.plex.direct:32400", "address": "192.168.1.5", "port": 32400, "local": true},
		{"uri": "https://[fe80::1]:32400", "local": true, "IPv6": true}
	]}`)
	got := strings.Join(r.Candidates(), " ")
	want := "https://192-168-1-5.abc.plex.direct:32400 http://192.168.1.5:32400 https://1-2-3-4.abc.plex.direct:32400 https://relay.plex.direct:8443"
	if got != want {
		t.Errorf("order\n got %s\nwant %s", got, want)
	}
	r.HTTPSRequired = true
	if strings.Contains(strings.Join(r.Candidates(), " "), "http://") {
		t.Error("a server that requires https was offered plain http")
	}
}

// The address kept is the one that answers as the server plex.tv listed, with
// its token; another server on an old address is passed over.
func TestReachTakesOnlyTheListedServer(t *testing.T) {
	serve := func(machine string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Plex-Token") != "server-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Write([]byte(`{"MediaContainer": {"machineIdentifier": "` + machine + `"}}`))
		}))
	}
	stranger, ours := serve("someone-else"), serve("abc")
	defer stranger.Close()
	defer ours.Close()
	r := resource(t, `{"name": "Home", "clientIdentifier": "abc", "accessToken": "server-token", "connections": [
		{"uri": "`+stranger.URL+`", "local": true}, {"uri": "`+ours.URL+`"}]}`)
	got, err := r.Reach(http.DefaultClient, "client")
	if err != nil || got != ours.URL {
		t.Fatalf("reach: %q %v, want %q", got, err, ours.URL)
	}
}
