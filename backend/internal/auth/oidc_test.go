package auth

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestClaimGrantsAdmin(t *testing.T) {
	cases := []struct {
		claims map[string]any
		name   string
		value  string
		want   bool
	}{
		{map[string]any{"groups": []any{"admin", "users"}}, "groups", "admin", true},
		{map[string]any{"groups": []any{"users"}}, "groups", "admin", false},
		{map[string]any{"role": "admin"}, "role", "admin", true},
		{map[string]any{"role": "user"}, "role", "admin", false},
		{map[string]any{"is_admin": true}, "is_admin", "true", true},
		{map[string]any{"is_admin": true}, "is_admin", "", true},
		{map[string]any{"is_admin": false}, "is_admin", "true", false},
		{map[string]any{}, "groups", "admin", false},
	}
	for _, c := range cases {
		if got := claimGrantsAdmin(c.claims, c.name, c.value); got != c.want {
			t.Errorf("claimGrantsAdmin(%v, %q, %q) = %v, want %v", c.claims, c.name, c.value, got, c.want)
		}
	}
}

func TestOIDCAdminSync(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	yes, no := true, false

	isAdmin := func(id int64) bool {
		var a bool
		d.QueryRow(`SELECT is_admin FROM users WHERE id = ?`, id).Scan(&a)
		return a
	}

	// first user becomes admin even when the claim says no
	id1, err := findOrCreateOIDCUser(d, "first@example.com", &no)
	if err != nil {
		t.Fatal(err)
	}
	if !isAdmin(id1) {
		t.Error("first user must be admin")
	}
	// claim promotes a new user
	id2, _ := findOrCreateOIDCUser(d, "second@example.com", &yes)
	if !isAdmin(id2) {
		t.Error("claim should promote new user")
	}
	// claim demotes an existing admin (another admin remains)
	findOrCreateOIDCUser(d, "second@example.com", &no)
	if isAdmin(id2) {
		t.Error("claim should demote existing user")
	}
	// last admin is never demoted
	findOrCreateOIDCUser(d, "first@example.com", &no)
	if !isAdmin(id1) {
		t.Error("last admin must not be demoted")
	}
	// nil = claim absent: no change
	findOrCreateOIDCUser(d, "second@example.com", nil)
	if isAdmin(id2) {
		t.Error("nil admin must not change is_admin")
	}
}
