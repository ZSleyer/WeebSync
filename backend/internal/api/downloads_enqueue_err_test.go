package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A download or one-off sync on a server whose host key is not trusted (yet)
// has to come back as the 409 with fingerprints, like every other dial: that
// is what lets the page offer the review. A plain 502 with the raw text left
// the user nowhere to accept the key. A failing queue write is the server's own
// fault, a 500, not the remote's 502.
func TestEnqueueErrorsByKind(t *testing.T) {
	mux, s, adminC, _, adminID, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	root := t.TempDir()
	s.DownloadRoot, s.LocalRoots = root, []string{root}
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc)
		VALUES (?, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`, adminID)
	if err != nil {
		t.Fatal(err)
	}
	srvID, _ := res.LastInsertId()

	var dialErr error
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		if dialErr != nil {
			return nil, "", dialErr
		}
		return &oneFileClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	s.Transfers = transfer.NewManager(s.DB, dial, root)
	s.Transfers.SetRoots([]string{root})

	routes := []struct{ path, body string }{
		{"/api/downloads", `{"serverId":` + strconv.FormatInt(srvID, 10) + `,"remotePath":"/x/Show","localPath":"Show"}`},
		{"/api/downloads/sync", `{"serverId":` + strconv.FormatInt(srvID, 10) + `,"remotePath":"/x/Show","localPath":"Show"}`},
	}

	for _, r := range routes {
		dialErr = &remote.HostKeyError{Offered: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"}
		rec := doReq(mux, "POST", r.path, r.body, adminC)
		if rec.Code != http.StatusConflict {
			t.Errorf("%s untrusted host key: got %d %s, want 409", r.path, rec.Code, rec.Body)
		} else {
			var c HostKeyConflict
			if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil || c.Code != "host_key_unknown" || c.NewKey == "" {
				t.Errorf("%s conflict body %s (err %v)", r.path, rec.Body, err)
			}
		}

		dialErr = nil
		if _, err := s.DB.Exec(`CREATE TRIGGER no_queue BEFORE INSERT ON downloads BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`); err != nil {
			t.Fatal(err)
		}
		rec = doReq(mux, "POST", r.path, r.body, adminC)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s queue write failed: got %d %s, want 500", r.path, rec.Code, rec.Body)
		}
		if _, err := s.DB.Exec(`DROP TRIGGER no_queue`); err != nil {
			t.Fatal(err)
		}
	}
}
