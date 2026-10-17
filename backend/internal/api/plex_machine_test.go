package api

import (
	"errors"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/plex"
)

// machineServer is a media server whose MachineID is counted and can fail.
type machineServer struct {
	plex.Server
	calls int
	fail  bool
}

func (m *machineServer) Kind() string { return "plex" }
func (m *machineServer) MachineID() (string, error) {
	m.calls++
	if m.fail {
		return "", errors.New("timeout")
	}
	return "mid", nil
}
func (m *machineServer) DeepLink(machineID, key string) string { return machineID + "/" + key }

// A dead server costs one lookup per 30 s, not one per link on a page.
func TestPlexLinkForRemembersAFailedMachineID(t *testing.T) {
	s := &Server{DB: dbtest.Open(t)}
	c := &machineServer{fail: true}
	for range 5 {
		if l := s.plexLinkFor(c, "1"); l != "" {
			t.Fatalf("link from a dead server: %q", l)
		}
	}
	if c.calls != 1 {
		t.Fatalf("%d lookups for 5 links, want 1", c.calls)
	}
	// after the retry window the server is asked again, and a recovery sticks
	s.machineFailed.Store("plex:machineid", time.Now().Add(-2*plexMachineRetry))
	c.fail = false
	if l := s.plexLinkFor(c, "1"); l != "mid/1" {
		t.Fatalf("recovered link = %q", l)
	}
	if l := s.plexLinkFor(c, "2"); l != "mid/2" || c.calls != 2 {
		t.Fatalf("link %q after %d lookups, want the cached id", l, c.calls)
	}
}
