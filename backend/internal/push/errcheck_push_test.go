package push

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
)

// A VAPID public key that could not be stored must fail New: with only the
// private half saved, the next start would mint a new pair and every existing
// subscription would be signed for the wrong key.
func TestNewFailsWhenPublicKeyNotStored(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`CREATE TRIGGER no_vapid_public BEFORE INSERT ON settings
		WHEN NEW.key = 'vapid_public' BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := New(d); err == nil {
		t.Fatal("New succeeded although the public key was not stored")
	}
	if got := db.Setting(d, "vapid_private"); got != "" {
		t.Errorf("private key stored without its public half: %q", got)
	}
}
