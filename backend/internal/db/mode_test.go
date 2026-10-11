package db

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenRestrictsDatabaseMode(t *testing.T) {
	name := filepath.Join(t.TempDir(), "test.db")
	if err := os.WriteFile(name, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	d, err := Open(name)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database mode = %o, want 600", info.Mode().Perm())
	}
}

// Every pooled connection commits without an fsync of its own (WAL +
// synchronous NORMAL): 1, not SQLite's default 2.
func TestOpenSyncsOnCheckpointOnly(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	d.SetMaxOpenConns(3)
	for range 3 {
		var mode int
		if err := d.QueryRow(`PRAGMA synchronous`).Scan(&mode); err != nil || mode != 1 {
			t.Fatalf("synchronous = %d, %v", mode, err)
		}
	}
}
