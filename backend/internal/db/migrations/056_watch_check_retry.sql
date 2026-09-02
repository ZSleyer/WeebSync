-- A watch check that failed waited a full interval before trying again.
--
-- runWatch dials the server and lists the remote folder before it can queue
-- anything. When that dial fails - the server rebooting, the network flapping -
-- the check recorded the error and the next attempt came with the normal
-- interval, up to half an hour later. The failure is usually over in seconds.
--
-- `check_attempts` counts consecutive failed checks and `retry_at` (unix seconds,
-- 0 = follow the normal schedule) brings the next one forward onto a short
-- backoff instead.
ALTER TABLE watches ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watches ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
