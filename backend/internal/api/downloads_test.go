package api

import (
	"net/http"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

func TestDownloadsBulk(t *testing.T) {
	mux, s, adminC, userC, adminID, userID := setupUsersTest(t)
	// max_concurrent 0: the manager loop must not start queued downloads
	// (its Dial is nil in tests) — we only exercise status transitions
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())

	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc)
		VALUES (?, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`, adminID)
	if err != nil {
		t.Fatal(err)
	}
	srvID, _ := res.LastInsertId()
	ins := func(uid int64, path, status string) {
		if _, err := s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status)
			VALUES (?, ?, ?, '/dl', ?)`, uid, srvID, path, status); err != nil {
			t.Fatal(err)
		}
	}
	ins(adminID, "/a.mkv", "queued")
	ins(adminID, "/b.mkv", "queued")
	ins(userID, "/c.mkv", "queued") // other user: must stay untouched

	if rec := doReq(mux, "POST", "/api/downloads/bulk", `{"action":"pause"}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("bulk pause: got %d: %s", rec.Code, rec.Body)
	}
	var paused, otherQueued int
	s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND status = 'paused'`, adminID).Scan(&paused)
	s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND status = 'queued'`, userID).Scan(&otherQueued)
	if paused != 2 || otherQueued != 1 {
		t.Errorf("after pause: own paused=%d (want 2), other queued=%d (want 1)", paused, otherQueued)
	}

	if rec := doReq(mux, "POST", "/api/downloads/bulk", `{"action":"resume"}`, adminC); rec.Code != http.StatusOK {
		t.Fatalf("bulk resume: got %d", rec.Code)
	}
	var queued int
	s.DB.QueryRow(`SELECT COUNT(*) FROM downloads WHERE user_id = ? AND status = 'queued'`, adminID).Scan(&queued)
	if queued != 2 {
		t.Errorf("after resume: queued=%d, want 2", queued)
	}

	if rec := doReq(mux, "POST", "/api/downloads/bulk", `{"action":"nope"}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid action: got %d, want 400", rec.Code)
	}

	// global limit: admin only, value persisted
	if rec := doReq(mux, "PUT", "/api/downloads/ratelimit", `{"rateLimit":1024}`, userC); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin global limit: got %d, want 403", rec.Code)
	}
	if rec := doReq(mux, "PUT", "/api/downloads/ratelimit", `{"rateLimit":1024}`, adminC); rec.Code != http.StatusOK {
		t.Errorf("global limit: got %d: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/downloads/ratelimit", `{"rateLimit":-1}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("negative limit: got %d, want 400", rec.Code)
	}
}
