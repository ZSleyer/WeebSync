-- A one-off upgrade sync may replace the copy it improves on: the download
-- remembers the request, and the files it displaces wait in a trash folder
-- until the sweep deletes them.
ALTER TABLE downloads ADD COLUMN replace_old INTEGER NOT NULL DEFAULT 0;

CREATE TABLE trash_files (
    path       TEXT PRIMARY KEY, -- absolute path inside a .weebsync-trash folder
    trashed_at INTEGER NOT NULL  -- unix seconds
);
