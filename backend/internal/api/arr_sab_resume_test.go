package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/transfer"
)

// A resume from Sonarr/Radarr that the queue refuses - another download for
// the same file is still on its way - used to be answered "ok" while nothing
// happened. The answer says it was not resumed, and why.
func TestSabResumeReportsBusyTarget(t *testing.T) {
	s, root := sizeTestServer(t)
	db.SetSetting(s.DB, "max_concurrent", "0")
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	dir := filepath.Join(root, "tv", "Show")
	target := filepath.Join(dir, "a.mkv")
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (7, 1, 1, '/r/a.mkv', ?, 'paused')`, target)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (8, 1, 1, '/r2/a.mkv', ?, 'queued')`, target)
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('job', 'g1', 7, 'Show', ?)`, dir)

	form := url.Values{"mode": {"queue"}, "name": {"resume"}, "value": {"job"}}
	r := httptest.NewRequest(http.MethodPost, "/api/arr/sab/api", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	s.sabQueue(rec, r)

	var out struct {
		Status bool   `json:"status"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %s: %v", rec.Body, err)
	}
	if rec.Code != http.StatusConflict || out.Status || out.Error == "" {
		t.Errorf("resume onto a busy target: %d %s; want 409 with status false and a reason", rec.Code, rec.Body)
	}
}
