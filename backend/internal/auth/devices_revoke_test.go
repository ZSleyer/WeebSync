package auth

import (
	"database/sql"
	"testing"
	"time"
)

func seedDevices(t *testing.T, d *sql.DB) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO device_tokens (user_id, token_hash, created_at) VALUES (1, 'ta', '` + now + `'), (2, 'tb', '` + now + `')`,
		`INSERT INTO device_pairings (device_code_hash, user_code_hash, status, user_id, created_at, expires_at)
			VALUES ('da', 'ua', 'approved', 1, 0, 9999999999), ('db', 'ub', 'approved', 2, 0, 9999999999)`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
}

func deviceRows(t *testing.T, d *sql.DB, user int64) int {
	t.Helper()
	var n int
	if err := d.QueryRow(`SELECT (SELECT COUNT(*) FROM device_tokens WHERE user_id = ?) + (SELECT COUNT(*) FROM device_pairings WHERE user_id = ?)`, user, user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A back-channel logout by subject (every login of the user) signs the
// paired devices out too; another account's devices stay.
func TestBackchannelLogoutRevokesDevices(t *testing.T) {
	for _, c := range []struct{ name, sid, sub string }{
		{"by subject", "", "user-a"},
	} {
		t.Run(c.name, func(t *testing.T) {
			m, keys, d := backchannelFixture(t)
			seedSessions(t, d)
			seedDevices(t, d)
			if rec := post(m, keys.sign(t, logoutClaims(c.sid, c.sub))); rec.Code != 200 {
				t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
			}
			if n := deviceRows(t, d, 1); n != 0 {
				t.Errorf("user 1 keeps %d device rows after the logout", n)
			}
			if n := deviceRows(t, d, 2); n != 2 {
				t.Errorf("user 2 has %d device rows, want both untouched", n)
			}
		})
	}
}

// A logout by subject reaches the devices a provider login approved even
// when no session of that login is left (expired or swept): the token
// carries the subject itself.
func TestBackchannelLogoutBySubjectWithoutSession(t *testing.T) {
	m, keys, d := backchannelFixture(t)
	seedSessions(t, d)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO device_tokens (user_id, token_hash, created_at, oidc_sub) VALUES (1, 'ta', '` + now + `', 'user-a'), (1, 'tc', '` + now + `', '')`,
		`INSERT INTO device_pairings (device_code_hash, user_code_hash, status, user_id, created_at, expires_at, oidc_sub)
			VALUES ('da', 'ua', 'approved', 1, 0, 9999999999, 'user-a')`,
		`DELETE FROM sessions`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if rec := post(m, keys.sign(t, logoutClaims("", "user-a"))); rec.Code != 200 {
		t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
	}
	var left string
	if err := d.QueryRow(`SELECT COALESCE(group_concat(token_hash), '') FROM device_tokens`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != "tc" {
		t.Errorf("device tokens left %q, want only the one a password session approved", left)
	}
	var pairings int
	if err := d.QueryRow(`SELECT COUNT(*) FROM device_pairings`).Scan(&pairings); err != nil || pairings != 0 {
		t.Errorf("approved pairings of user-a left: %d (%v)", pairings, err)
	}
}

// A logout by sid ends one browser's login at the provider, not the user
// everywhere: the paired devices keep working.
func TestBackchannelLogoutBySidKeepsDevices(t *testing.T) {
	for _, c := range []struct{ name, sid, sub string }{
		{"sid only", "sid-1", ""},
		{"sid with subject", "sid-1", "user-a"},
	} {
		t.Run(c.name, func(t *testing.T) {
			m, keys, d := backchannelFixture(t)
			seedSessions(t, d)
			seedDevices(t, d)
			if rec := post(m, keys.sign(t, logoutClaims(c.sid, c.sub))); rec.Code != 200 {
				t.Fatalf("want 200, got %d %s", rec.Code, rec.Body)
			}
			if n := count(t, d); n != 2 {
				t.Errorf("both logins of sid-1 should be gone, %d session rows left", n)
			}
			if n := deviceRows(t, d, 1); n != 2 {
				t.Errorf("user 1 has %d device rows after a single-session logout, want both", n)
			}
		})
	}
}

// A new password ends the paired devices with the other sessions.
func TestSetPasswordRevokesDevices(t *testing.T) {
	_, _, d := backchannelFixture(t)
	seedSessions(t, d)
	seedDevices(t, d)
	if err := SetPassword(d, 1, "fourth horse battery staple", ""); err != nil {
		t.Fatal(err)
	}
	if n := deviceRows(t, d, 1); n != 0 {
		t.Errorf("user 1 keeps %d device rows after a new password", n)
	}
	if n := deviceRows(t, d, 2); n != 2 {
		t.Errorf("user 2 has %d device rows, want both untouched", n)
	}
}
