package api

import (
	"context"
	"path/filepath"
	"testing"
)

// A pending episode is recorded the moment its download is queued, and the
// sweep drops entries whose file is not on disk. With a long queue an episode
// is still waiting after the half hour the sweep leaves an entry alone - its
// file does not exist yet, only because it has not been fetched. Dropping it
// then left the finished file in the collecting folder for good. Only a
// download that ended without a file may lose its entry: done and moved away
// by hand, failed, or canceled.
func TestPendingEpisodeSurvivesWhileDownloadInFlight(t *testing.T) {
	s, root := pendingFixture(t)
	cases := []struct {
		status string
		keep   bool
	}{
		{"queued", true},
		{"running", true},
		{"paused", true},
		{"done", false},
		{"error", false},
		{"canceled", false},
	}
	for i, c := range cases {
		id := int64(100 + i)
		local := filepath.Join(root, "Conan", "_Unzugeordnet", c.status+".mkv")
		if _, err := s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status)
			VALUES (?, 1, 1, ?, ?, ?)`, id, "/ftp/Conan/"+c.status+".mkv", local, c.status); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec(`INSERT INTO pending_episodes (download_id, watch_id, token, local_path, remote_path, created_at)
			VALUES (?, 1, '1208', ?, ?, datetime('now', '-2 hours'))`, id, local, "/ftp/Conan/"+c.status+".mkv"); err != nil {
			t.Fatal(err)
		}
	}

	s.processPendingEpisodes(context.Background())

	for i, c := range cases {
		var n int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM pending_episodes WHERE download_id = ?`, 100+i).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if got := n == 1; got != c.keep {
			t.Errorf("download %s: entry kept = %v, want %v", c.status, got, c.keep)
		}
	}
}
