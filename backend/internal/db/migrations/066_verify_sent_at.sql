-- A verification link stops working after a day. Links already out at the
-- time of the migration start their clock now.
ALTER TABLE users ADD COLUMN verify_sent_at TEXT NOT NULL DEFAULT '';
UPDATE users SET verify_sent_at = datetime('now') WHERE verify_token != '';
