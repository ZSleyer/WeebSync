package push

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/secret"
)

func TestSubscriptionCannotChangeOwner(t *testing.T) {
	dir := t.TempDir()
	if err := secret.Init(dir); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	s, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES
		(1, 'one@example.com', ''), (2, 'two@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	if err := s.Subscribe(1, "https://push.example/a", "key", "auth"); err != nil {
		t.Fatal(err)
	}
	if err := s.Subscribe(2, "https://push.example/a", "other", "other"); !errors.Is(err, ErrEndpointOwned) {
		t.Fatalf("owner transfer error = %v", err)
	}
}
