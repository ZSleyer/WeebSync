-- Auto-sync writes directly into local_path by default (matching a flat
-- library layout). subfolder=1 keeps the old behavior of creating a folder
-- named after the remote directory. Existing watches default to flat.
ALTER TABLE watches ADD COLUMN subfolder INTEGER NOT NULL DEFAULT 0;
