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

// A back-channel logout signs the user out of the paired devices too, by sid
// and by subject; another account's devices stay.
func TestBackchannelLogoutRevokesDevices(t *testing.T) {
	for _, c := range []struct{ name, sid, sub string }{
		{"by sid", "sid-1", ""},
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
