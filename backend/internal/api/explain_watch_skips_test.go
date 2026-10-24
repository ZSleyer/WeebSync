package api

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A broken last_skips column still explains the watch (empty skip list, not
// null) but is logged instead of vanishing silently.
func TestWatchExplainLogsBrokenSkips(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, DownloadRoot: t.TempDir()})
	mux := http.NewServeMux()
	s.Register(mux)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'example.com', 22, 'u', X'00', '/')`)
	c := cookieForUser(t, d, 1)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, last_skips) VALUES (1, 1, '/x/Show', '/lib', '{broken')`)

	rec := doReq(mux, "GET", "/api/watches/1/explain", "", c)
	if rec.Code != http.StatusOK {
		t.Fatalf("explain: got %d: %s", rec.Code, rec.Body)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if string(out["skips"]) != "[]" {
		t.Errorf("skips = %s, want []", out["skips"])
	}
	if !strings.Contains(buf.String(), "last_skips") {
		t.Errorf("broken last_skips not logged: %q", buf.String())
	}
}
