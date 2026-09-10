-- The last TOTP code a user got in with. A code is valid for a 90-second
-- window; remembering the accepted one closes replay inside that window.
ALTER TABLE user_totp ADD COLUMN last_code TEXT NOT NULL DEFAULT '';
