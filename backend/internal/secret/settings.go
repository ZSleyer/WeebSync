package secret

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

const settingPrefix = "enc:v1:"

var settingKeys = []string{
	"anilist_client_secret", "tmdb_api_key", "tvdb_api_key", "ai_api_key",
	"plex_token", "oidc_client_secret", "smtp_password", "vapid_private",
}

func encodeSetting(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	enc, err := Encrypt(value)
	if err != nil {
		return "", err
	}
	return settingPrefix + base64.StdEncoding.EncodeToString(enc), nil
}

func decodeSetting(value string) (string, error) {
	if !strings.HasPrefix(value, settingPrefix) {
		return value, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, settingPrefix))
	if err != nil {
		return "", err
	}
	return Decrypt(raw)
}

// SettingOrEnv reads an encrypted setting with the same environment override
// semantics as db.SettingOrEnv. Invalid ciphertext is treated as unset; startup
// migration reports the actual error before services are constructed.
func SettingOrEnv(d *sql.DB, key, envVar string) string {
	if value := os.Getenv(envVar); value != "" {
		return value
	}
	var value string
	d.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	plain, _ := decodeSetting(value)
	return plain
}

func SetSetting(d *sql.DB, key, value string) error {
	enc, err := encodeSetting(value)
	if err != nil {
		return err
	}
	_, err = d.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, enc)
	return err
}

// MigrateSettings encrypts legacy plaintext settings in one transaction. The
// old SMTP value was already AES-GCM but lacked a version marker.
func MigrateSettings(d *sql.DB) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, key := range settingKeys {
		var value string
		err := tx.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
		if err == sql.ErrNoRows || value == "" {
			continue
		}
		if err != nil {
			return err
		}
		if strings.HasPrefix(value, settingPrefix) {
			if _, err := decodeSetting(value); err != nil {
				return fmt.Errorf("decrypt setting %s: %w", key, err)
			}
			continue
		}
		plain := value
		if key == "smtp_password" {
			raw, err := base64.StdEncoding.DecodeString(value)
			if err != nil {
				return fmt.Errorf("decode legacy smtp password: %w", err)
			}
			plain, err = Decrypt(raw)
			if err != nil {
				return err
			}
		}
		enc, err := encodeSetting(plain)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE settings SET value = ? WHERE key = ?`, enc, key); err != nil {
			return err
		}
	}
	return tx.Commit()
}
