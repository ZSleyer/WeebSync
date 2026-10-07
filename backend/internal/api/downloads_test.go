package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

func TestDownloadsBulk(t *testing.T) {
	mux, s, adminC, userC, adminID, userID := setupUsersTest(t)
	// max_concurrent 0: the manager loop must not start queued downloads
	// (its Dial is nil in tests) - we only exercise status transitions
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

func TestDownloadsReorder(t *testing.T) {
	mux, s, adminC, _, adminID, userID := setupUsersTest(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())

	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc)
		VALUES (?, 'srv', 'sftp', 'example.com', 22, 'u', x'00')`, adminID)
	if err != nil {
		t.Fatal(err)
	}
	srvID, _ := res.LastInsertId()
	ins := func(uid int64, path, status string, pos int) int64 {
		r, err := s.DB.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, status, queue_pos)
			VALUES (?, ?, ?, '/dl', ?, ?)`, uid, srvID, path, status, pos)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := r.LastInsertId()
		return id
	}
	a := ins(adminID, "/a.mkv", "queued", 1)
	c := ins(userID, "/c.mkv", "queued", 2) // someone else's, between the two
	b := ins(adminID, "/b.mkv", "queued", 3)
	run := ins(adminID, "/r.mkv", "running", 4)
	pos := func(id int64) (p int) {
		s.DB.QueryRow(`SELECT queue_pos FROM downloads WHERE id = ?`, id).Scan(&p)
		return
	}

	body := func(ids ...int64) string {
		out := `{"ids":[`
		for i, id := range ids {
			if i > 0 {
				out += ","
			}
			out += strconv.FormatInt(id, 10)
		}
		return out + `]}`
	}
	if rec := doReq(mux, "POST", "/api/downloads/reorder", body(b, a), adminC); rec.Code != http.StatusOK {
		t.Fatalf("reorder: got %d: %s", rec.Code, rec.Body)
	}
	// b takes a's slot, a takes b's; the other user's file keeps its place
	// between them, so nobody jumped ahead of it
	if pos(b) != 1 || pos(a) != 3 || pos(c) != 2 {
		t.Errorf("positions: b=%d a=%d c=%d, want 1 3 2", pos(b), pos(a), pos(c))
	}

	for name, ids := range map[string][]int64{
		"missing one":   {a},
		"running row":   {a, b, run},
		"foreign row":   {a, c},
		"duplicate id":  {a, a},
		"unknown extra": {a, b, 9999},
	} {
		if rec := doReq(mux, "POST", "/api/downloads/reorder", body(ids...), adminC); rec.Code != http.StatusConflict {
			t.Errorf("%s: got %d, want 409", name, rec.Code)
		}
	}
	if rec := doReq(mux, "POST", "/api/downloads/reorder", `{"ids":[]}`, adminC); rec.Code != http.StatusBadRequest {
		t.Errorf("empty: got %d, want 400", rec.Code)
	}
	if pos(b) != 1 || pos(a) != 3 {
		t.Error("a rejected reorder changed the queue")
	}
}

func TestSpeedHistoryEndpoint(t *testing.T) {
	mux, s, _, userC, _, _ := setupUsersTest(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())

	rec := doReq(mux, "GET", "/api/downloads/speed", "", userC)
	if rec.Code != http.StatusOK {
		t.Fatalf("speed history: got %d: %s", rec.Code, rec.Body)
	}
	var body SpeedHistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Samples) != transfer.SpeedSpan || body.End == 0 {
		t.Fatalf("got %d samples, end %d; want %d and a timestamp", len(body.Samples), body.End, transfer.SpeedSpan)
	}
}
