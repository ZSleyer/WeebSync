package auth

import (
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestClaimMatches(t *testing.T) {
	cases := []struct {
		claims map[string]any
		name   string
		values string
		want   bool
	}{
		{map[string]any{"groups": []any{"admin", "users"}}, "groups", "admin", true},
		{map[string]any{"groups": []any{"users"}}, "groups", "admin", false},
		{map[string]any{"groups": []any{"users"}}, "groups", "admin, users", true},
		{map[string]any{"groups": []any{"b"}}, "groups", "a,b,c", true},
		{map[string]any{"role": "admin"}, "role", "admin", true},
		{map[string]any{"role": "user"}, "role", "admin", false},
		{map[string]any{"is_admin": true}, "is_admin", "true", true},
		{map[string]any{"is_admin": false}, "is_admin", "true", false},
		{map[string]any{}, "groups", "admin", false},
		{map[string]any{"groups": []any{"admin"}}, "groups", "", false},
	}
	for _, c := range cases {
		if got := claimMatches(c.claims, c.name, splitCSV(c.values)); got != c.want {
			t.Errorf("claimMatches(%v, %q, %q) = %v, want %v", c.claims, c.name, c.values, got, c.want)
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
	id1, err := findOrCreateOIDCUser(d, "first@example.com", &no, true)
	if err != nil {
		t.Fatal(err)
	}
	if !isAdmin(id1) {
		t.Error("first user must be admin")
	}
	// claim promotes a new user
	id2, _ := findOrCreateOIDCUser(d, "second@example.com", &yes, true)
	if !isAdmin(id2) {
		t.Error("claim should promote new user")
	}
	// claim demotes an existing admin (another admin remains)
	findOrCreateOIDCUser(d, "second@example.com", &no, true)
	if isAdmin(id2) {
		t.Error("claim should demote existing user")
	}
	// last admin is never demoted
	findOrCreateOIDCUser(d, "first@example.com", &no, true)
	if !isAdmin(id1) {
		t.Error("last admin must not be demoted")
	}
	// nil = claim absent: no change
	findOrCreateOIDCUser(d, "second@example.com", nil, true)
	if isAdmin(id2) {
		t.Error("nil admin must not change is_admin")
	}

	// ungated (no allowlist) + not the first account: new identities are refused
	if _, err := findOrCreateOIDCUser(d, "stranger@example.com", nil, false); err == nil {
		t.Error("ungated provisioning of a new identity must be refused")
	}
	// but an existing account still logs in even ungated
	if _, err := findOrCreateOIDCUser(d, "first@example.com", nil, false); err != nil {
		t.Errorf("existing user must log in even ungated: %v", err)
	}
}

func TestEmailVerified(t *testing.T) {
	cases := []struct {
		claims map[string]any
		want   bool
	}{
		{map[string]any{"email_verified": true}, true},
		{map[string]any{"email_verified": "true"}, true},
		{map[string]any{"email_verified": false}, false},
		{map[string]any{"email_verified": "false"}, false},
		{map[string]any{}, false}, // missing → fail closed
		{map[string]any{"email_verified": 1}, false},
	}
	for _, c := range cases {
		if got := emailVerified(c.claims); got != c.want {
			t.Errorf("emailVerified(%v) = %v, want %v", c.claims, got, c.want)
		}
	}
}
