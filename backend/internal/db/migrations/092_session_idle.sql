-- Sessions end after a stretch without use as well as at their hard expiry,
-- and how long both are depends on "stay signed in" (auth/session.go).
-- last_seen is stamped at most every few minutes; '' (every session from
-- before this column) counts as seen now and is stamped on its next request,
-- so the upgrade signs nobody out. Sessions from before count as remembered,
-- which is what their 30-day cookie already was.
ALTER TABLE sessions ADD COLUMN last_seen TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 1;
-- the choice rides along while the second factor is asked for
ALTER TABLE login_pending ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;
