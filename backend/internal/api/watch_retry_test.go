package api

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A check that cannot reach the server has to come back in seconds, not after
// a full interval - the failure is usually over long before the next slot.
// A successful check clears the backoff again, or one bad minute would keep a
// watch on the short ladder forever.
func TestWatchCheckFailureSchedulesRetry(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	root := t.TempDir()
	reachable := false
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		if !reachable {
			return nil, "", errors.New("dial tcp: connection refused")
		}
		return &oneFileClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}

	// the queue must not start anything: this test is about the check, and a
	// download running into the temp directory races its cleanup
	d.Exec(`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	res, err := d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode)
		VALUES (1, 1, '/x/Show', 'Show', 'template')`)
	if err != nil {
		t.Fatal(err)
	}
	watchID, _ := res.LastInsertId()

	read := func() (attempts int, retryAt int64, result string) {
		t.Helper()
		if err := d.QueryRow(`SELECT check_attempts, retry_at, last_result FROM watches WHERE id = ?`, watchID).
			Scan(&attempts, &retryAt, &result); err != nil {
			t.Fatal(err)
		}
		return
	}

	s.runWatch(watchID)
	attempts, retryAt, result := read()
	if attempts != 1 {
		t.Errorf("check_attempts = %d, want 1", attempts)
	}
	if retryAt <= time.Now().Unix() {
		t.Errorf("retry_at = %d, want a time in the future", retryAt)
	}
	if result == "" {
		t.Error("last_result is empty, want the dial error")
	}

	// still down: the count climbs, so the backoff can widen
	s.runWatch(watchID)
	if attempts, _, _ = read(); attempts != 2 {
		t.Errorf("check_attempts = %d after the second failure, want 2", attempts)
	}

	reachable = true
	s.runWatch(watchID)
	attempts, retryAt, result = read()
	if attempts != 0 || retryAt != 0 {
		t.Errorf("after a good check: check_attempts %d retry_at %d, want 0/0", attempts, retryAt)
	}
	if result != "" {
		t.Errorf("last_result = %q, want cleared", result)
	}
}

// nextCheckAt has to report the retry, not the interval: the watches page
// counts down to what it returns, and a countdown to a moment when nothing
// happens is worse than none.
func TestNextCheckAtPrefersRetry(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	retry := now.Add(2 * time.Minute).Unix()
	got := nextCheckAt(now.Format("2006-01-02 15:04:05"), 30*time.Minute, false, 0, retry, now)
	if got != retry {
		t.Errorf("nextCheckAt = %d, want the retry time %d", got, retry)
	}
}

func TestWatchBackoffDoublesUpToTheInterval(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	// 10 minutes, so the ceiling sits inside the doubling rather than beyond it
	d.Exec(`INSERT INTO settings (key, value) VALUES ('watch_interval_min', '10')`)
	s := &Server{DB: d}

	for _, tc := range []struct {
		attempts int
		want     time.Duration
	}{
		{0, time.Minute},
		{1, time.Minute},
		{2, 2 * time.Minute},
		{3, 4 * time.Minute},
		{4, 8 * time.Minute},
		{5, 10 * time.Minute}, // 16m would exceed the interval: held there
		{99, 10 * time.Minute},
	} {
		if got := s.watchBackoff(tc.attempts); got != tc.want {
			t.Errorf("watchBackoff(%d) = %v, want %v", tc.attempts, got, tc.want)
		}
	}
}
