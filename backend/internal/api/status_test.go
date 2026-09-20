package api

import (
	"encoding/json"
	"testing"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// The machine status carries the attention aggregate, the job snapshot and
// the queue totals - the fields a Home Assistant sensor reads. The reasons
// come from the same watchAttention the UI shows, so both always agree.
func TestStatusCarriesAttentionAndJobs(t *testing.T) {
	mux, s, adminC, _, _, _ := setupUsersTest(t)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	s.DownloadRoot = t.TempDir()

	s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`)
	s.DB.Exec(`INSERT INTO watches (user_id, server_id, remote_path, local_path, mode, template, title_override, last_result)
		VALUES (1, 1, '/x/Show', 'Show', 'template', 'Show - E{episode:02}', 'Show', 'connect refused')`)

	rec := doReq(mux, "GET", "/api/status", "", adminC)
	if rec.Code != 200 {
		t.Fatalf("status: got %d: %s", rec.Code, rec.Body)
	}
	var out StatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Attention.Count != 1 || out.Attention.Reasons["checkFailed"] != 1 {
		t.Errorf("attention = %+v, want the failed check counted once", out.Attention)
	}
	if len(out.Attention.Watches) != 1 || out.Attention.Watches[0].Name != "Show" {
		t.Errorf("attention watches = %+v, want the one named watch", out.Attention.Watches)
	}
	if out.Jobs.Running == nil || out.Jobs.Paused == nil {
		t.Errorf("jobs = %+v, want empty lists, not null", out.Jobs)
	}
	if out.NextReleases == nil {
		t.Errorf("nextReleases missing, want an empty list, not null")
	}
}
