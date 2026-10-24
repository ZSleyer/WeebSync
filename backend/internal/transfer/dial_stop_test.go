package transfer

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
)

// A connection the configuration itself rules out does not come back by
// waiting: an untrusted or changed host key needs the user's review, plain FTP
// is refused for good, and a blocked address stays blocked. Each used to
// classify as transient, so every queued file of the server dialed again ten
// times over twenty minutes before it said anything. They end the download at
// once, with a code the page can explain.
func TestConfigDialFailuresAreNotRetried(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{&remote.HostKeyError{Offered: "AAAA"}, ErrCodeHostKey},
		{fmt.Errorf("dial: %w", &remote.HostKeyError{Offered: "AAAA", Stored: "BBBB"}), ErrCodeHostKey},
		{remote.ErrPlainFTP, ErrCodePlainFTP},
		{fmt.Errorf("lease: %w", remote.ErrBlockedHost), ErrCodeBlockedHost},
	}
	for _, c := range cases {
		t.Run(c.code, func(t *testing.T) {
			d := newRetryDB(t)
			dial := func(userID, serverID int64) (remote.Client, string, error) { return nil, "", c.err }
			m := NewManager(d, dial, t.TempDir())
			t.Cleanup(func() { m.Shutdown(t.Context()) })
			res, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
				VALUES (1, 1, '/x/ep01.mkv', ?, 8)`, filepath.Join(t.TempDir(), "ep01.mkv"))
			if err != nil {
				t.Fatal(err)
			}
			id, _ := res.LastInsertId()
			m.Wake()
			waitFor(t, "the download to end", func() bool {
				r := readRow(t, d, id)
				return r.status == "error" || r.attempts > 0
			})
			r := readRow(t, d, id)
			if r.status != "error" || r.attempts != 0 || r.code != c.code {
				t.Errorf("status %q attempts %d code %q; want error, 0 attempts, %q", r.status, r.attempts, r.code, c.code)
			}
		})
	}
	// a plain connection failure stays transient
	if code := classifyError(errors.New("connection reset by peer")); !RetryableCode(code) {
		t.Errorf("a dropped connection classified %q, which is not retried", code)
	}
}
