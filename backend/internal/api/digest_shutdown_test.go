package api

import (
	"context"
	"sync"
	"testing"
	"time"
)

// A daily digest collects in memory for up to a day; a container restart in
// between used to drop it without a trace. Shutdown has to send what is
// collected before the database closes.
func TestShutdownFlushesCollectedDigests(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, time.Hour)()
	var mu sync.Mutex
	sent := map[string]int{}
	s.digestSend = func(userID int64, category string, items []digestItem) {
		mu.Lock()
		defer mu.Unlock()
		sent[category] += len(items)
	}
	// the queue still works: a timer flush would wait another round
	insertDownload(t, s, "running")
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/one.mkv"})
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/two.mkv"})
	s.NotifyDownload(1, "download_failed", digestItem{serverID: 1, remotePath: "/three.mkv", note: "x"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Shutdown(ctx)

	mu.Lock()
	defer mu.Unlock()
	if sent["download_done"] != 2 || sent["download_failed"] != 1 {
		t.Fatalf("sent at shutdown = %v, want 2 done and 1 failed", sent)
	}
	s.digestMu.Lock()
	defer s.digestMu.Unlock()
	if len(s.digest) != 0 {
		t.Errorf("digests left after shutdown: %v", s.digest)
	}
}

// A send that hangs (an SMTP server that never answers) must not hold the
// shutdown past its budget.
func TestShutdownDigestFlushBoundedByBudget(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, time.Hour)()
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	s.digestSend = func(int64, string, []digestItem) {
		started <- struct{}{}
		<-release
	}
	defer close(release)
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/one.mkv"})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	returned := make(chan struct{})
	go func() {
		s.Shutdown(ctx)
		close(returned)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the digest was never sent at shutdown")
	}
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("a hanging send held Shutdown past its budget")
	}
}
