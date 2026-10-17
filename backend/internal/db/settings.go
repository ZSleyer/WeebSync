package db

import (
	"database/sql"
	"errors"
	"log/slog"
	"os"
)

// Setting reads a settings key; empty string when unset.
func Setting(d *sql.DB, key string) string {
	var v string
	// unset reads as "", the callers' default; a real failure is logged
	if err := d.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Warn("setting not read", "key", key, "err", err)
	}
	return v
}

// SettingOrEnv reads a settings key with an env override - a set env var
// wins over the DB value (the UI shows such fields as locked).
func SettingOrEnv(d *sql.DB, key, envVar string) string {
	if v := os.Getenv(envVar); v != "" {
		return v
	}
	return Setting(d, key)
}

// Execer is what a write needs: a *sql.DB, or a *sql.Tx when the write has to
// land together with others.
type Execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func SetSetting(d Execer, key, value string) error {
	_, err := d.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
