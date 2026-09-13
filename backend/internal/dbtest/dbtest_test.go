package dbtest

import (
	"os"
	"path/filepath"
	"testing"
)

// The copied template has to carry every migration, otherwise a test would
// silently run against a half-built schema.
func TestOpenCarriesTheWholeSchema(t *testing.T) {
	d := Open(t)
	var recorded int
	if err := d.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join("..", "db", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if recorded != len(entries) {
		t.Fatalf("migrations recorded = %d, want %d", recorded, len(entries))
	}
}

// A file the test brought along stays as it is - the manual tests hand over a
// copy of a real database and must not have it overwritten.
func TestOpenAtKeepsAnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "own.db")
	seed(t, path)
	d := OpenAt(t, path)
	if _, err := d.Exec(`INSERT INTO settings (key, value) VALUES ('marker', 'kept')`); err != nil {
		t.Fatal(err)
	}
	d.Close()

	var value string
	if err := OpenAt(t, path).QueryRow(`SELECT value FROM settings WHERE key = 'marker'`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "kept" {
		t.Fatalf("value = %q, want %q", value, "kept")
	}
}
