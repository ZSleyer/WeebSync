-- Notification preferences beyond the existing email_prefs (which stays the
-- opt-in category list for mail). push_prefs is the same idea for web push,
-- which had no per-category filter before - defaulted to the two download
-- categories so existing subscribers keep getting what they got. notify_freq
-- is the delivery cadence for the batched digest: instant | hourly | daily.
ALTER TABLE users ADD COLUMN push_prefs   TEXT NOT NULL DEFAULT 'download_done,download_failed';
ALTER TABLE users ADD COLUMN notify_freq  TEXT NOT NULL DEFAULT 'instant';
