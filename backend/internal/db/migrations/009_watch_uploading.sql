-- Machine-readable check result: number of remote files still uploading at
-- the last check. The human-readable last_result stays for display only.
ALTER TABLE watches ADD COLUMN last_uploading INTEGER NOT NULL DEFAULT 0;
