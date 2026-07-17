package db

import (
	"database/sql"
	"os"
)

// Setting reads a settings key; empty string when unset.
func Setting(d *sql.DB, key string) string {
	var v string
	d.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v
}

// SettingOrEnv reads a settings key with an env override — a set env var
// wins over the DB value (the UI shows such fields as locked).
func SettingOrEnv(d *sql.DB, key, envVar string) string {
	if v := os.Getenv(envVar); v != "" {
		return v
	}
	return Setting(d, key)
}

func SetSetting(d *sql.DB, key, value string) error {
	_, err := d.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
