// Package db opens the embedded SQLite database and applies migrations.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"sort"

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
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := migrate(d); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
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
		if _, err := d.Exec(string(sqlBytes)); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := d.Exec(`INSERT INTO schema_migrations (name) VALUES (?)`, name); err != nil {
			return err
		}
	}
	return nil
}
