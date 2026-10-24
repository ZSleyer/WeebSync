package push

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
)

func vapidTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	if err := secret.Init(dir); err != nil {
		t.Fatal(err)
	}
	return dbtest.OpenAt(t, filepath.Join(dir, "test.db"))
}

// A stored private key that no longer decrypts (secret key swapped, file
// replaced) must fail New. Minting a new pair instead binds the instance to a
// key no browser subscribed with: every push is refused from then on while
// the browsers still show push as active.
func TestNewRefusesUndecodablePrivateKey(t *testing.T) {
	d := vapidTestDB(t)
	const pub, priv = "BPUBLIC", "enc:v1:AAAA"
	if err := db.SetSetting(d, "vapid_public", pub); err != nil {
		t.Fatal(err)
	}
	if err := db.SetSetting(d, "vapid_private", priv); err != nil {
		t.Fatal(err)
	}
	if _, err := New(d); err == nil {
		t.Fatal("New succeeded with an undecodable private key")
	}
	if got := db.Setting(d, "vapid_public"); got != pub {
		t.Errorf("public key overwritten: %q", got)
	}
	if got := db.Setting(d, "vapid_private"); got != priv {
		t.Errorf("private key overwritten: %q", got)
	}
}

// The two halves land together or not at all: a private key that could not
// be stored must not leave a fresh public key behind for the next start to
// pair with something else.
func TestNewStoresBothKeysOrNeither(t *testing.T) {
	d := vapidTestDB(t)
	if _, err := d.Exec(`CREATE TRIGGER no_vapid_private BEFORE INSERT ON settings
		WHEN NEW.key = 'vapid_private' BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := New(d); err == nil {
		t.Fatal("New succeeded although the private key was not stored")
	}
	if got := db.Setting(d, "vapid_public"); got != "" {
		t.Errorf("public key stored without its private half: %q", got)
	}
}

// A fresh instance still gets a pair, and the next start reads the same one.
func TestNewKeepsGeneratedPair(t *testing.T) {
	d := vapidTestDB(t)
	a, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	if a.public == "" || a.public != b.public || a.private != b.private {
		t.Fatalf("pair changed between starts: %q/%q", a.public, b.public)
	}
}
