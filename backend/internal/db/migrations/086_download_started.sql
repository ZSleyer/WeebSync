-- When a download last went running and how far it already was then, so the
-- history can say how long the transfer took and at what rate. Empty for rows
-- that ran before this column existed.
ALTER TABLE downloads ADD COLUMN started_at TEXT NOT NULL DEFAULT '';
ALTER TABLE downloads ADD COLUMN start_bytes INTEGER NOT NULL DEFAULT 0;
