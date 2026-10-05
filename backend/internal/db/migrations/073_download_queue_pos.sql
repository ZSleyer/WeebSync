-- The queue had no order of its own: the scheduler started the oldest queued
-- row first (ORDER BY id), so a file someone wanted now waited behind every
-- file queued before it. queue_pos is that order. It starts out as the id, so
-- nothing moves on upgrade; a new row takes the next position after the last
-- one, and a reorder only swaps positions between rows of the same user.
ALTER TABLE downloads ADD COLUMN queue_pos INTEGER NOT NULL DEFAULT 0;
UPDATE downloads SET queue_pos = id;
CREATE INDEX idx_downloads_queue ON downloads (status, queue_pos);
