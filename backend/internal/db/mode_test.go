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
