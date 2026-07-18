-- Videos present on the remote at the last check but skipped by the watch's
-- dub/sub language filter (target not yet local) - surfaced as a "waiting for
-- Ger-Dub" indicator so a language-gated backlog is distinguishable.
ALTER TABLE watches ADD COLUMN last_filtered INTEGER NOT NULL DEFAULT 0;
