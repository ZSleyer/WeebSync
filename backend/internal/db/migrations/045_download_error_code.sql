-- Why a download failed, as a stable code instead of a Go error string.
--
-- A container without write permission on the media mount produced
-- "open /media/.../ep.mkv.part: permission denied" - text the UI could only
-- truncate, and text no code could branch on without matching on wording. The
-- classified code lets the frontend explain the failure and lets the queue tell
-- a hopeless failure from a transient one; `error` keeps the original text for
-- diagnosis.
ALTER TABLE downloads ADD COLUMN error_code TEXT NOT NULL DEFAULT '';
