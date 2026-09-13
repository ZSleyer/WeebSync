// Package dbtest hands tests a migrated database without paying for the
// migrations every time.
//
// Applying the migrations means running their DDL through the SQLite engine,
// which is pure Go. Under the race detector every memory access inside that
// engine is instrumented, so a fresh db.Open costs close to a second, while
// re-opening an already migrated file costs a few milliseconds. Tests open a
// database a few hundred times, so the difference decides how long the suite
// runs. Migrating once per test binary and copying the resulting file gives
// every test the same schema for the cheaper price.
package dbtest

import (
	"database/sql"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

var (
	once     sync.Once
	template []byte
	buildErr error
)

// Open returns a migrated database below the test's temporary directory and
// closes it once the test ends.
func Open(t testing.TB) *sql.DB {
	t.Helper()
	return OpenAt(t, filepath.Join(t.TempDir(), "test.db"))
}

// OpenAt is Open at a path the caller picks, for tests that also inspect the
// file itself. A file that already holds something is opened as it is, so a
// test can still hand over a database it prepared on its own.
func OpenAt(t testing.TB, path string) *sql.DB {
	t.Helper()
	if info, err := os.Stat(path); err != nil || info.Size() == 0 {
		seed(t, path)
	}
	d, err := db.Open(path)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func seed(t testing.TB, path string) {
	t.Helper()
	once.Do(build)
	if buildErr != nil {
		t.Fatalf("build template database: %v", buildErr)
	}
	if err := os.WriteFile(path, template, 0o600); err != nil {
		t.Fatalf("seed test database: %v", err)
	}
}

func build() {
	dir, err := os.MkdirTemp("", "weebsync-dbtest")
	if err != nil {
		buildErr = err
		return
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "template.db")
	d, err := db.Open(path)
	if err != nil {
		buildErr = err
		return
	}
	// WAL leaves the migrations in the sidecar file. Fold them into the main
	// file so that copying that one file carries the whole schema.
	if _, err := d.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		d.Close()
		buildErr = err
		return
	}
	if err := d.Close(); err != nil {
		buildErr = err
		return
	}
	template, buildErr = os.ReadFile(path)
}
