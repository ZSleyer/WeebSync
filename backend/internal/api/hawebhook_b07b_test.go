package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A webhook that could not be delivered must not use up the attention
// fingerprint, or Home Assistant never hears of the change.
func TestHaAttentionRetriesAfterFailedPost(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	down := true
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer target.Close()
	d.Exec(`INSERT INTO settings (key, value) VALUES ('ha_webhook_url', ?)`, target.URL)
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, title_override, last_result)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'E{episode:02}', 'Show', 'boom')`)

	if got := s.haAttentionPost(""); got != "" {
		t.Fatalf("failed post advanced the fingerprint to %q", got)
	}
	down = false
	if got := s.haAttentionPost(""); got == "" {
		t.Error("retry after recovery did not deliver")
	}
}

// The webhook id is the only secret of the URL: the error handed to the log
// must not carry it.
func TestHaWebhookErrorOmitsURL(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	target := httptest.NewServer(http.NotFoundHandler())
	url := target.URL + "/api/webhook/SECRET-ID-123"
	target.Close() // connection refused
	d.Exec(`INSERT INTO settings (key, value) VALUES ('ha_webhook_url', ?)`, url)
	err := s.postHaWebhook(map[string]any{"event": "x"})
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "SECRET-ID-123") || strings.Contains(err.Error(), "/api/webhook") {
		t.Errorf("error carries the webhook URL: %v", err)
	}
}

// The notification runs under spawn, so Shutdown waits for it and does not
// sit out its retry pause.
func TestNotifyHaDownloadIsTracked(t *testing.T) {
	d := dbtest.Open(t)
	s := testServer(t, &Server{DB: d, Anilist: anilist.New(d)})
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer target.Close()
	d.Exec(`INSERT INTO settings (key, value) VALUES ('ha_webhook_url', ?)`, target.URL)
	s.NotifyHaDownload(&transfer.Download{RemotePath: "/x/a.mkv", Status: "done"})
	if s.bg.Load() == 0 {
		t.Fatal("notification is not tracked by spawn")
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.Shutdown(ctx)
	if time.Since(start) > time.Second || s.bg.Load() != 0 {
		t.Errorf("Shutdown took %v with %d tasks left", time.Since(start), s.bg.Load())
	}
}
