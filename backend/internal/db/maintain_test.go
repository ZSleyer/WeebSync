package db

import (
	"path/filepath"
	"testing"
)

// Opening the database looks after it: a file that is mostly free pages after
// a big delete is rewritten, and the planner gets statistics for the tables.
func TestOpenCompactsAndAnalyzes(t *testing.T) {
	name := filepath.Join(t.TempDir(), "test.db")
	d, err := Open(name)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE t (k TEXT, v TEXT)`,
		`CREATE INDEX t_k ON t(k)`,
		`INSERT INTO t WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
			SELECT i % 50, hex(randomblob(64)) FROM n`,
		`DELETE FROM t WHERE k > '1'`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	var pages, free int
	d.QueryRow(`PRAGMA page_count`).Scan(&pages)
	d.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	d.Close()
	if float64(free)/float64(pages) < compactAt {
		t.Fatalf("setup left only %d of %d pages free", free, pages)
	}

	d, err = Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	if free != 0 {
		t.Errorf("free pages after reopen: %d", free)
	}
	var stats int
	d.QueryRow(`SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 't'`).Scan(&stats)
	if stats == 0 {
		t.Error("no planner statistics for t")
	}
}
