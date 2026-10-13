-- Why the last check of a watch left files on the server: a JSON list of
-- {path, reason, detail}, at most 50. The counts beside it (last_filtered,
-- last_owned, last_uploading) say how many; this says which and why, for the
-- explanation on the series page. Written by every check, so it never ages.
ALTER TABLE watches ADD COLUMN last_skips TEXT NOT NULL DEFAULT '[]';
