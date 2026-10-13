package api

import (
	"encoding/json"
	"testing"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// A done row says when it landed, for "new here"; a row still on its way does not.
func TestDownloadsListFinishedAt(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size, status, updated_at)
		VALUES (1, 1, '/a/E01.mkv', 'a', 1, 'done', '2026-10-12 08:00:00'),
		       (1, 1, '/a/E02.mkv', 'a', 1, 'queued', '2026-10-12 09:00:00')`)

	rec := doReq(mux, "GET", "/api/downloads", "", adminC)
	var list []transfer.Download
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 2 {
		t.Fatalf("list: %v %s", err, rec.Body)
	}
	for _, d := range list {
		want := ""
		if d.Status == "done" {
			want = "2026-10-12 08:00:00"
		}
		if d.FinishedAt != want {
			t.Errorf("%s (%s): finishedAt = %q, want %q", d.RemotePath, d.Status, d.FinishedAt, want)
		}
	}
}
