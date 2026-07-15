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

// SettingOrEnv reads a settings key, falling back to an env var — env acts
// as bootstrap/deploy default, the DB value (set via frontend) wins.
func SettingOrEnv(d *sql.DB, key, envVar string) string {
	if v := Setting(d, key); v != "" {
		return v
	}
	return os.Getenv(envVar)
}

func SetSetting(d *sql.DB, key, value string) error {
	_, err := d.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
