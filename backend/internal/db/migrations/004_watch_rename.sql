-- Watches: regex rename support; the check interval becomes a global
-- setting (watch_interval_min) instead of a per-watch column.
ALTER TABLE watches DROP COLUMN interval_min;
ALTER TABLE watches ADD COLUMN mode TEXT NOT NULL DEFAULT 'template';
ALTER TABLE watches ADD COLUMN pattern TEXT NOT NULL DEFAULT '';
ALTER TABLE watches ADD COLUMN replacement TEXT NOT NULL DEFAULT '';
