-- How many files the last check left on the remote because the library
-- already holds their episode under another name (Plex, Sonarr).
ALTER TABLE watches ADD COLUMN last_owned INTEGER NOT NULL DEFAULT 0;
