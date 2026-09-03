package secret

import (
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/db"
)

func TestMigrateSettings(t *testing.T) {
	dir := t.TempDir()
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	db.SetSetting(d, "ai_api_key", "plain")
	legacy, _ := Encrypt("mail-secret")
	db.SetSetting(d, "smtp_password", base64.StdEncoding.EncodeToString(legacy))
	if err := MigrateSettings(d); err != nil {
		t.Fatal(err)
	}
	if got := SettingOrEnv(d, "ai_api_key", "TEST_UNUSED"); got != "plain" {
		t.Fatalf("api key = %q", got)
	}
	if got := SettingOrEnv(d, "smtp_password", "TEST_UNUSED"); got != "mail-secret" {
		t.Fatalf("smtp password = %q", got)
	}
	if raw := db.Setting(d, "ai_api_key"); !strings.HasPrefix(raw, settingPrefix) || strings.Contains(raw, "plain") {
		t.Fatalf("setting not encrypted: %q", raw)
	}
	if err := MigrateSettings(d); err != nil {
		t.Fatalf("migration is not idempotent: %v", err)
	}
}
