package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/transfer"
)

// SABnzbd's delete with value=all clears one list only: the queue, or the
// history (https://sabnzbd.org/wiki/configuration/4.5/api, "queue delete" and
// "history delete"). The other list's jobs must survive.
func TestSabDeleteAllStaysInItsList(t *testing.T) {
	s, root := sizeTestServer(t)
	s.Transfers = transfer.NewManager(s.DB, nil, t.TempDir())
	dir := filepath.Join(root, "tv", "Show")
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (7, 1, 1, '/r/a.mkv', ?, 'running')`,
		filepath.Join(dir, "a.mkv"))
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('running', 'g1', 7, 'Show', ?)`, dir)
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('finished', 'g2', 0, 'Other', ?)`, dir)

	call := func(h http.HandlerFunc, mode string) {
		form := url.Values{"mode": {mode}, "name": {"delete"}, "value": {"all"}}
		r := httptest.NewRequest(http.MethodPost, "/api/arr/sab/api", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		h(httptest.NewRecorder(), r)
	}
	left := func() map[string]bool {
		out := map[string]bool{}
		rows, err := s.DB.Query(`SELECT nzo_id FROM arr_jobs`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var n string
			rows.Scan(&n)
			out[n] = true
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	call(s.sabHistory, "history")
	if got := left(); !got["running"] || got["finished"] {
		t.Errorf("history delete all left %v, want only the running job", got)
	}
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('finished', 'g2', 0, 'Other', ?)`, dir)
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('queued', 'g3', 8, 'Third', ?)`, dir)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (8, 1, 1, '/r/c.mkv', ?, 'queued')`,
		filepath.Join(dir, "c.mkv"))
	call(s.sabQueue, "queue")
	if got := left(); got["running"] || got["queued"] || !got["finished"] {
		t.Errorf("queue delete all left %v, want only the finished job", got)
	}
}
