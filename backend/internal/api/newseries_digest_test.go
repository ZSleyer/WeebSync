package api

import (
	"testing"
	"time"
)

func newSeriesHeld(s *Server, user int64) int {
	s.newSeriesMu.Lock()
	defer s.newSeriesMu.Unlock()
	if b := s.newSeries[user]; b != nil {
		return len(b.titles)
	}
	return 0
}

// A burst of finds is collected while it runs and leaves as one summary after
// it goes quiet; before, each find was its own push re-alerting on one tag.
func TestNotifyNewSeriesCollectsBurst(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, 100*time.Millisecond)()

	for _, title := range []string{"A", "B", "B", "C"} {
		s.notifyNewSeries(1, title, "")
		time.Sleep(40 * time.Millisecond) // shorter than the quiet period
	}
	if got := newSeriesHeld(s, 1); got != 3 {
		t.Fatalf("burst not held together: %d titles, want 3 (duplicate dropped)", got)
	}
	waitFor(t, 2*time.Second, func() bool { return newSeriesHeld(s, 1) == 0 },
		"summary never went out once the burst was quiet")
}

// A burst that never goes quiet still reports once the cap is reached.
func TestNotifyNewSeriesMaxWait(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, 60*time.Millisecond)()
	old := newSeriesMaxWait
	newSeriesMaxWait = 150 * time.Millisecond
	defer func() { newSeriesMaxWait = old }()

	// a find every 30ms restarts the 60ms quiet period forever; only the cap
	// can end this batch
	stop := time.Now().Add(1 * time.Second)
	flushed := false
	for i := 0; time.Now().Before(stop) && !flushed; i++ {
		s.notifyNewSeries(1, string(rune('A'+i)), "")
		time.Sleep(30 * time.Millisecond)
		flushed = newSeriesHeld(s, 1) == 0
	}
	if !flushed {
		t.Fatal("running burst never reported")
	}
}

func TestNewSeriesSummary(t *testing.T) {
	if title, body := newSeriesSummary("de", []string{"Solo"}); title != "Neue Serie gefunden" || body != "Solo" {
		t.Errorf("single: %q / %q", title, body)
	}
	title, body := newSeriesSummary("de", []string{"A", "B", "C", "D", "E"})
	if title != "5 neue Serien gefunden" || body != "A, B, C und 2 weitere" {
		t.Errorf("many: %q / %q", title, body)
	}
}
