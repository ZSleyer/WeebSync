package api

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestLoginPendingIsConsumedOnce(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: d}
	token, err := s.newLoginPending(1)
	if err != nil {
		t.Fatal(err)
	}
	if !s.consumeLoginPending(token, 1) {
		t.Fatal("valid pending login was rejected")
	}
	if s.consumeLoginPending(token, 1) {
		t.Fatal("pending login was consumed twice")
	}
}
