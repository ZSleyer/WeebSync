package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// An install from before the sign-in counts as a pasted token (and is asked
// to sign in), a sign-in is one, and a token from the environment is neither,
// as the UI cannot change it.
func TestPlexAuth(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	db.SetSetting(d, "plex_token", "enc:v1:x")
	if got := s.plexAuth("plex"); got != "token" {
		t.Errorf("pasted: %q", got)
	}
	db.SetSetting(d, "plex_auth", "signin")
	if got := s.plexAuth("plex"); got != "signin" {
		t.Errorf("signed in: %q", got)
	}
	db.SetSetting(d, "plex_token", "")
	t.Setenv("PLEX_TOKEN", "from-env")
	if got := s.plexAuth("plex"); got != "env" {
		t.Errorf("env: %q", got)
	}
}

// The server connected first stays in use when the second joins, a choice by
// hand overrides that, and losing the chosen one falls back to the other.
func TestMediaServerPrecedence(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	kind := func() string {
		s.syncMediaServer() // what every connect and settings save runs
		if c := s.plexClient(); c != nil {
			return c.Kind()
		}
		return ""
	}
	if kind() != "" {
		t.Fatal("nothing configured must give no server")
	}
	db.SetSetting(d, "jellyfin_url", "http://jellyfin.example.com")
	db.SetSetting(d, "jellyfin_token", "key")
	if k := kind(); k != "jellyfin" || s.mediaServerName() != "Jellyfin" {
		t.Fatalf("only Jellyfin set: %q", k)
	}
	db.SetSetting(d, "plex_url", "http://plex.example.com")
	db.SetSetting(d, "plex_token", "tok")
	if k := kind(); k != "jellyfin" {
		t.Fatalf("Jellyfin came first and must stay: %q", k)
	}
	db.SetSetting(d, "media_server", "plex")
	if k := kind(); k != "plex" || s.mediaServerName() != "Plex" {
		t.Fatalf("chosen by hand: %q", k)
	}
	db.SetSetting(d, "plex_token", "")
	if k := kind(); k != "jellyfin" || db.Setting(d, "media_server") != "jellyfin" {
		t.Fatalf("the chosen one gone, the other takes over: %q", k)
	}

	// two connected at once: nothing is chosen for the admin, neither runs
	d2 := dbtest.Open(t)
	s2 := testServer(t, &Server{DB: d2})
	for k, v := range map[string]string{"plex_url": "http://p", "plex_token": "t", "jellyfin_url": "http://j", "jellyfin_token": "k"} {
		db.SetSetting(d2, k, v)
	}
	s2.syncMediaServer()
	if s2.plexClient() != nil || !s2.mediaServerUnchosen() {
		t.Fatal("both at once must wait for a choice")
	}
	db.SetSetting(d2, "media_server", "jellyfin")
	if c := s2.plexClient(); c == nil || c.Kind() != "jellyfin" || s2.mediaServerUnchosen() {
		t.Fatal("the choice must take effect")
	}
}
