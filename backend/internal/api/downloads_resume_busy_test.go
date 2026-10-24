package api

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// Retrying a failed download whose file another row is already fetching is
// refused as a conflict, not reported as a server error.
func TestResumeBusyTargetIsConflict(t *testing.T) {
	_, s, adminC, _, adminID, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	mux := http.NewServeMux() // the action routes bind the manager at registration
	s.Register(mux)
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc)
		VALUES (?, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`, adminID)
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := res.LastInsertId()
	ins := func(remotePath, status string) int64 {
		res, err := s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status)
			VALUES (?, ?, ?, '/dl/ep01.mkv', ?)`, adminID, srv, remotePath, status)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	old := ins("/a/ep01.mkv", "error")
	ins("/b/ep01.mkv", "queued")
	rec := doReq(mux, "POST", "/api/downloads/"+strconv.FormatInt(old, 10)+"/resume", "", adminC)
	if rec.Code != http.StatusConflict {
		t.Errorf("resume onto a busy target: got %d %s, want 409", rec.Code, rec.Body)
	}
}
