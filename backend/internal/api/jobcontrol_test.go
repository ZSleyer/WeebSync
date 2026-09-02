package api

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestJobFamilyStripsIds(t *testing.T) {
	for _, tc := range []struct{ key, want string }{
		{"plex:index", "plex"},
		{"crawl:2", "crawl"},
		{"m:1:/Some/Folder", "m"},
		{"anime:ids", "anime"},
		{"sweep", "sweep"},
		{"", ""},
	} {
		if got := jobFamily(tc.key); got != tc.want {
			t.Errorf("jobFamily(%q) = %q, want %q", tc.key, got, tc.want)
		}
	}
}

// A paused family must not start, and the pause has to outlive a restart -
// it is reached for precisely when something is running away with the machine,
// and a setting that only lived in memory would let it come straight back.
func TestPausedFamilyDoesNotStart(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}

	ran := make(chan string, 4)
	s.runJob("plex:index", func(context.Context) { ran <- "first" })
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("the job did not run while nothing was paused")
	}

	db.SetSetting(d, "jobs_paused", "plex")
	if !s.jobPaused("plex:index") {
		t.Fatal("jobPaused says no for a paused family")
	}
	if s.jobPaused("crawl:1") {
		t.Error("pausing plex also paused crawl")
	}
	s.runJob("plex:index", func(context.Context) { ran <- "second" })
	select {
	case got := <-ran:
		t.Fatalf("a paused job ran anyway (%q)", got)
	case <-time.After(300 * time.Millisecond):
	}

	// a fresh Server on the same database sees the pause: it is a setting
	if !(&Server{DB: d}).jobPaused("plex:index") {
		t.Error("the pause did not survive a restart")
	}
}

// Stopping cancels the running job's context. What the job does with that is
// its own business, so the test asserts the signal, not a deadline.
func TestStopJobCancelsTheContext(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := &Server{DB: d}

	started, done := make(chan struct{}), make(chan struct{})
	s.runJobFor("plex:index", time.Minute, func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(done)
	})
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("the job never started")
	}

	if s.stopJob("plex:suggest") {
		t.Error("stopping a job that is not running reported success")
	}
	if !s.stopJob("plex:index") {
		t.Fatal("stopping the running job reported failure")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the job's context was not cancelled")
	}
}
