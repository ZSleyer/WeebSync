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
	s := &Server{DB: d}
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

// Plex wins when both servers are set up; Jellyfin stands in only without it.
func TestMediaServerPrecedence(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d}
	if s.plexClient() != nil {
		t.Fatal("nothing configured must give no server")
	}
	db.SetSetting(d, "jellyfin_url", "http://jellyfin.example.com")
	db.SetSetting(d, "jellyfin_token", "key")
	if c := s.plexClient(); c == nil || c.Kind() != "jellyfin" || s.mediaServerName() != "Jellyfin" {
		t.Fatalf("only Jellyfin set: %v", c)
	}
	db.SetSetting(d, "plex_url", "http://plex.example.com")
	db.SetSetting(d, "plex_token", "tok")
	if c := s.plexClient(); c == nil || c.Kind() != "plex" || s.mediaServerName() != "Plex" {
		t.Fatalf("both set must give Plex: %v", c)
	}
}
