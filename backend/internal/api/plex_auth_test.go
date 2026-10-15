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
