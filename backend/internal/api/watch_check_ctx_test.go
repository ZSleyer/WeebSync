package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// canceledAfter reports the context as live for the first n Err calls and as
// canceled from then on: a cancel that lands in the middle of a check.
type canceledAfter struct {
	context.Context
	n     int32
	calls atomic.Int32
}

func (c *canceledAfter) Err() error {
	if c.calls.Add(1) > c.n {
		return context.Canceled
	}
	return nil
}

func watchCtxServer(t *testing.T) (*Server, *http.ServeMux, *http.Cookie, *atomic.Int32) {
	t.Helper()
	d := dbtest.Open(t)
	root := t.TempDir()
	dials := new(atomic.Int32)
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		dials.Add(1)
		return nil, "", errors.New("dial tcp: connection refused")
	}
	s := &Server{DB: d, DownloadRoot: root, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, dial, root)}
	drainJobsAtCleanup(t, s)
	mux := http.NewServeMux()
	s.Register(mux)
	for _, q := range []string{
		`INSERT INTO settings (key, value) VALUES ('max_concurrent', '0')`,
		`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`,
		`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
			VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`,
		`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode) VALUES (1, 1, '/x/A', 'A', 'template')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return s, mux, cookieForUser(t, d, 1), dials
}

func lastCheck(t *testing.T, s *Server) string {
	t.Helper()
	var v string
	if err := s.DB.QueryRow(`SELECT last_check FROM watches WHERE id = 1`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// A check canceled after it started but before it reached the server did not
// happen: the watch must not read as checked.
func TestCanceledCheckIsNotStamped(t *testing.T) {
	s, _, _, dials := watchCtxServer(t)
	out := s.runWatch(&canceledAfter{Context: context.Background(), n: 1}, 1)
	if out.Error == "" {
		t.Errorf("runWatch = %+v, want the cancel", out)
	}
	if n := dials.Load(); n != 0 {
		t.Errorf("dialed %d times after the cancel", n)
	}
	if v := lastCheck(t, s); v != "" {
		t.Errorf("last_check = %q, want it untouched", v)
	}
}

// A check the user asked for and waits on runs to the end even when the tab
// closes: the request's cancel does not reach it.
func TestWaitedCheckSurvivesClosedTab(t *testing.T) {
	s, mux, cookie, dials := watchCtxServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequestWithContext(ctx, "POST", "/api/watches/1/check?wait=1", nil)
	req.AddCookie(cookie)
	mux.ServeHTTP(httptest.NewRecorder(), req)
	if n := dials.Load(); n != 1 {
		t.Errorf("dialed %d times, want the check to run", n)
	}
	if v := lastCheck(t, s); v == "" {
		t.Error("last_check not stamped: the check did not run")
	}
}
