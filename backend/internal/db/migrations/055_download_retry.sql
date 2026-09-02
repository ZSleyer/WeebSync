-- A dropped connection used to end a download for good.
--
-- The transfer worker had one terminal state for every failure: `error`. But a
-- reset TCP connection, a short read or a server that goes away for a minute all
-- clear up by themselves - the file is half on disk, the .part offset is right
-- there, and nothing has to change on the host. Only a human clicking Retry ever
-- picked those back up, which for an auto-sync running at night means the episode
-- is simply missing in the morning.
--
-- `attempts` counts the failures so far and `retry_at` says when the next attempt
-- may start (unix seconds, 0 = right away). A waiting row stays `queued`, so the
-- queue keeps one vocabulary of states and the duplicate check in Enqueue already
-- covers it; only the worker's pick-up query learns to respect the clock.
ALTER TABLE downloads ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE downloads ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
