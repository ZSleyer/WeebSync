// Package db opens the embedded SQLite database and applies migrations.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(path string) (*sql.DB, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	// busy_timeout + WAL: multiple goroutines (API + download workers) share the handle.
	// synchronous NORMAL: in WAL mode a commit is no longer an fsync of its own,
	// only a checkpoint is - a running download commits its progress every
	// second, on a box without an SSD each of those was a disk seek. It cannot
	// corrupt the database; a power cut may lose the last commits.
	// journal_size_limit: a checkpoint rewinds the WAL but left the file at its
	// high-water mark, one big write burst kept it that size for good.
	// analysis_limit: every ANALYZE that Optimize triggers reads a sample,
	// milliseconds instead of the whole file.
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"+
		"&_pragma=journal_size_limit(%d)&_pragma=analysis_limit(400)", path, 16<<20)
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := migrate(d); err != nil {
		d.Close()
		return nil, err
	}
	compact(d)
	Optimize(d)
	// a connection reads the statistics when it opens and never again, so the
	// ones that ran the migrations go and the pool starts fresh. And none is
	// kept longer than an hour, which is how a later Optimize reaches them.
	d.Close()
	if d, err = sql.Open("sqlite", dsn); err != nil {
		return nil, err
	}
	d.SetConnMaxLifetime(time.Hour)
	return d, nil
}

// Optimize refreshes the query planner's statistics where they are missing or
// a table has changed a lot since, and does nothing otherwise, so it is cheap
// to call on every sweep. Without statistics SQLite cannot tell a narrow index
// range from a whole server's prefix of remote_index and may pick the scan.
// 0x10000: look at every table, not only those this pooled connection touched.
func Optimize(d *sql.DB) {
	if _, err := d.Exec(`PRAGMA optimize=0x10002`); err != nil {
		slog.Warn("db optimize failed", "err", err)
	}
}

// compactAt is the share of free pages above which compact rewrites the file.
const compactAt = 0.2

// compact rewrites the database once a fifth of it is free pages, which is
// what a big prune or a data reset leaves behind: SQLite reuses free pages but
// never hands them back, and the live rows stay scattered over the old extent.
// Only here, before anything else holds the handle: VACUUM keeps the write
// lock for its whole run, longer than any busy_timeout on a slow disk.
// Best effort - short of disk space it fails and the file stays as it was.
func compact(d *sql.DB) {
	var pages, free int64
	d.QueryRow(`PRAGMA page_count`).Scan(&pages)
	d.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	if pages == 0 || float64(free)/float64(pages) < compactAt {
		return
	}
	if _, err := d.Exec(`VACUUM`); err != nil {
		slog.Warn("db compact failed", "pages", pages, "free", free, "err", err)
		return
	}
	slog.Info("db compacted", "pages", pages, "freed", free)
}

// appliedMigrations reads the whole ledger at once. Asking per file instead
// costs one round trip through the SQLite engine for every migration, which
// adds up once there are dozens of them.
func appliedMigrations(d *sql.DB) (map[string]bool, error) {
	rows, err := d.Query(`SELECT name FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	applied := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		applied[name] = true
	}
	return applied, rows.Err()
}

func migrate(d *sql.DB) error {
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	entries, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)
	applied, err := appliedMigrations(d)
	if err != nil {
		return err
	}
	for _, name := range entries {
		if applied[name] {
			continue
		}
		sqlBytes, err := migrations.ReadFile(name)
		if err != nil {
			return err
		}
		if err := applyMigration(d, name, string(sqlBytes)); err != nil {
			return err
		}
	}
	return nil
}

// applyMigration runs one file and records it in a single transaction. Run as
// separate commits, a crash or a failing statement midway left the first
// statements applied and the file unrecorded: on the next start it ran again,
// failed on its own "duplicate column", and the app never came up.
func applyMigration(d *sql.DB, name, body string) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(body); err != nil {
		return fmt.Errorf("migration %s: %w", name, err)
	}
	if _, err := tx.Exec(`INSERT INTO schema_migrations (name) VALUES (?)`, name); err != nil {
		return err
	}
	return tx.Commit()
}
