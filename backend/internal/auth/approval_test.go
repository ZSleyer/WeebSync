package auth

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A new identity from the provider waits for an admin unless it is the first
// account or the provider's groups make it an admin.
func TestOIDCNewIdentityWaitsForApproval(t *testing.T) {
	d := dbtest.Open(t)
	yes, no := true, false
	approved := func(id int64) bool {
		var a bool
		d.QueryRow(`SELECT approved FROM users WHERE id = ?`, id).Scan(&a)
		return a
	}
	first, created, err := findOrCreateOIDCUserNew(d, "first@example.com", &no, true)
	if err != nil || !created || !approved(first) {
		t.Fatalf("first account: created=%v approved=%v err=%v", created, approved(first), err)
	}
	member, created, _ := findOrCreateOIDCUserNew(d, "member@example.com", &no, true)
	if !created || approved(member) {
		t.Errorf("new member approved without an admin: created=%v", created)
	}
	if _, created, _ := findOrCreateOIDCUserNew(d, "member@example.com", &no, true); created {
		t.Error("second sign-in reported as created")
	}
	boss, _, _ := findOrCreateOIDCUserNew(d, "boss@example.com", &yes, true)
	if !approved(boss) {
		t.Error("an admin by the provider's groups waits for approval")
	}
}
