package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// The reads whose result decides what is downloaded, created or wiped next
// report a failure as an error, never as an empty result: an empty skip list
// downloads again, an empty series lookup creates a duplicate, an empty job
// list makes Sonarr give a job up, an empty requeue list loses folders.
func TestDecidingReadsFailLoudly(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d})
	d.Close()
	if _, err := s.pendingRemotePaths(1); err == nil {
		t.Error("pendingRemotePaths: no error")
	}
	if _, err := s.sabJobs(); err == nil {
		t.Error("sabJobs: no error")
	}
	if _, err := s.automaticMatches("1 = 1"); err == nil {
		t.Error("automaticMatches: no error")
	}
	if _, err := s.findSeries("key", 2020, false); err == nil {
		t.Error("findSeries: no error")
	}
	if _, _, err := s.seriesProviderMaps(); err == nil {
		t.Error("seriesProviderMaps: no error")
	}
	if _, ok := s.scanQuality(1, "/x"); ok {
		t.Error("scanQuality: ok on an unreadable listing")
	}
}
