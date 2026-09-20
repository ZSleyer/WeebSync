package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A finished download reaches the configured webhook as one event; without
// a URL nothing is posted. The attention post fires only when the picture
// changes - the fingerprint keeps a quiet instance quiet.
func TestHaWebhook(t *testing.T) {
	d := dbtest.Open(t)
	s := &Server{DB: d, Anilist: anilist.New(d)}

	var got atomic.Value
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got.Store(string(body))
		calls.Add(1)
	}))
	defer target.Close()

	// no URL configured: nothing posted, no error
	s.postHaWebhook(map[string]any{"event": "x"})
	if calls.Load() != 0 {
		t.Fatalf("posted without a URL")
	}

	d.Exec(`INSERT INTO settings (key, value) VALUES ('ha_webhook_url', ?)`, target.URL)
	s.postHaWebhook(map[string]any{"event": "download_finished", "name": "Show - E01.mkv"})
	if calls.Load() != 1 {
		t.Fatalf("posts = %d, want 1", calls.Load())
	}
	var ev map[string]any
	json.Unmarshal([]byte(got.Load().(string)), &ev)
	if ev["event"] != "download_finished" || ev["name"] != "Show - E01.mkv" {
		t.Errorf("payload = %v", ev)
	}

	// the download event derives its name and event from the download
	s.NotifyHaDownload(&transfer.Download{RemotePath: "/x/Show - E02.mkv", Status: "error", Error: "io", ErrorCode: "disk_full"})
	waitFor(t, 2*time.Second, func() bool { return calls.Load() == 2 }, "download event never arrived")
	json.Unmarshal([]byte(got.Load().(string)), &ev)
	if ev["event"] != "download_error" || ev["errorCode"] != "disk_full" {
		t.Errorf("payload = %v", ev)
	}

	// attention: a failing watch posts once, the same picture stays silent
	d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`)
	d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	d.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, title_override, last_result)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'E{episode:02}', 'Show', 'boom')`)
	fp := s.haAttentionPost("")
	if fp == "" || calls.Load() != 3 {
		t.Fatalf("fingerprint %q, posts %d, want a post with a fingerprint", fp, calls.Load())
	}
	json.Unmarshal([]byte(got.Load().(string)), &ev)
	if ev["event"] != "attention_changed" || ev["count"] != float64(1) {
		t.Errorf("payload = %v", ev)
	}
	if again := s.haAttentionPost(fp); again != fp || calls.Load() != 3 {
		t.Errorf("unchanged picture reposted: fp %q -> %q, posts %d", fp, again, calls.Load())
	}
}
