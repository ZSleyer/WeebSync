-- Local (password) accounts can require email verification when SMTP is set up.
-- Existing accounts are grandfathered in as verified so nobody gets locked out.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1;
ALTER TABLE users ADD COLUMN verify_token TEXT NOT NULL DEFAULT '';
-- opt-in per-user email notifications: CSV of enabled category keys
-- (download_done, download_failed, admin_new_user). Empty = no emails.
ALTER TABLE users ADD COLUMN email_prefs TEXT NOT NULL DEFAULT '';
