package api

import (
	"os"
	"path/filepath"
	"testing"
)

// SQLite hands the id of a deleted download out again. A job that pointed at
// the deleted one must not take the newcomer for its download: no foreign
// status, no suppressed notification, no cancel; and when the file is in the
// job folder the job is done, not failed.
func TestArrJobSurvivesDownloadIDReuse(t *testing.T) {
	s, root := sizeTestServer(t)
	jobDir := filepath.Join(root, "tv", "Show S01E01")
	if err := os.MkdirAll(jobDir, 0o755); err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(jobDir, "Show S01E01.mkv")
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (500, 1, 1, '/r/a.mkv', ?, 'done')`, own)
	s.DB.Exec(`INSERT INTO arr_jobs (nzo_id, guid, download_id, title, job_dir) VALUES ('n1', 'g', 500, 'Show S01E01', ?)`, jobDir)
	if !s.isArrJob(500) {
		t.Fatal("the job's own download is not recognised")
	}

	// the user clears it; the next manual download gets id 500 again
	s.DB.Exec(`DELETE FROM downloads WHERE id = 500`)
	s.DB.Exec(`INSERT INTO downloads (id, user_id, server_id, remote_path, local_path, status) VALUES (500, 1, 1, '/r/b.mkv', ?, 'running')`,
		filepath.Join(root, "manual", "b.mkv"))
	if s.isArrJob(500) {
		t.Error("a foreign download with a reused id counts as an arr job")
	}
	jobs, err := s.sabJobs()
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs %v, err %v", jobs, err)
	}
	if j := jobs[0]; j.status == "running" || j.downloadID != 0 || j.userID != 0 {
		t.Errorf("job adopted the foreign download: %+v", j)
	}
	if jobs[0].status != "error" {
		t.Errorf("no file and no download: status = %q, want error", jobs[0].status)
	}

	// the file is there: only the record is gone, the job is done
	if err := os.WriteFile(own, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.DB.Exec(`DELETE FROM downloads WHERE id = 500`)
	jobs, _ = s.sabJobs()
	if jobs[0].status != "done" {
		t.Errorf("file present, record gone: status = %q, want done", jobs[0].status)
	}
}
