package api

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestExpireAuthRowsKeepsLiveRows(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	live := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	dead := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('s-live', 1, ?)`,
		`INSERT INTO login_pending (token_hash, user_id, expires_at) VALUES ('p-live', 1, ?)`,
	} {
		if _, err := d.Exec(q, live); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('s-dead', 1, ?)`,
		`INSERT INTO login_pending (token_hash, user_id, expires_at) VALUES ('p-dead', 1, ?)`,
	} {
		if _, err := d.Exec(q, dead); err != nil {
			t.Fatal(err)
		}
	}
	(&Server{DB: d}).expireAuthRows()
	for _, table := range []string{"sessions", "login_pending"} {
		var n int
		var left string
		d.QueryRow(`SELECT count(*), min(token_hash) FROM `+table).Scan(&n, &left)
		if n != 1 || left[2:] != "live" {
			t.Fatalf("%s: %d rows left, first %q", table, n, left)
		}
	}
}
