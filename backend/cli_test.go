package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

func TestResetPassword(t *testing.T) {
	dir := t.TempDir()
	d, err := db.Open(filepath.Join(dir, "weebsync.db"))
	if err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO users (email) VALUES ('admin@example.com')`)
	d.Close()

	stdin := func(s string) *os.File {
		r, w, _ := os.Pipe()
		w.WriteString(s)
		w.Close()
		return r
	}
	var out bytes.Buffer
	if code := resetPassword(dir, []string{"nobody@example.com"}, stdin("longenough123\n"), &out); code != 1 {
		t.Errorf("unknown account: exit %d, want 1 (%s)", code, &out)
	}
	if code := resetPassword(dir, []string{"admin@example.com"}, stdin("short\n"), &out); code != 1 {
		t.Errorf("weak password: exit %d, want 1 (%s)", code, &out)
	}
	if code := resetPassword(dir, []string{"Admin@Example.com"}, stdin("longenough123\n"), &out); code != 0 {
		t.Fatalf("reset: exit %d, want 0 (%s)", code, &out)
	}
	d, _ = db.Open(filepath.Join(dir, "weebsync.db"))
	defer d.Close()
	var hash string
	d.QueryRow(`SELECT password_hash FROM users WHERE email = 'admin@example.com'`).Scan(&hash)
	if !auth.VerifyPassword("longenough123", hash) {
		t.Errorf("stored password does not verify")
	}
}
